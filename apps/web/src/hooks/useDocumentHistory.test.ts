// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workspacePath } from '@markroot/core';
import { DocumentSession } from '@markroot/document';
import { historyKey, UndoTree, type HistoryBackend, type HistoryJSON } from '@markroot/history';
import { isHistoryShortcut, useDocumentHistory } from './useDocumentHistory.js';
import { deferred, mountHook } from './hook-test-utils.js';

function setup(source = 'root', saved?: unknown) {
  const session = new DocumentSession(workspacePath('a.md'), source);
  const values = new Map<string, unknown>(); if (saved) values.set(historyKey('project', 'a.md'), saved);
  const backend: HistoryBackend = { load: vi.fn((key: string) => Promise.resolve(values.get(key))), save: vi.fn((key: string, data: HistoryJSON) => { values.set(key, structuredClone(data)); return Promise.resolve(); }) };
  const options: Parameters<typeof useDocumentHistory>[0] = { session, workspaceId: 'project', backend, setNotice: vi.fn(), onNavigate: vi.fn() };
  return { session, values, backend, options, hook: mountHook(useDocumentHistory, options) };
}
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
afterEach(() => vi.useRealTimers());

describe('document history integration', () => {
  it('undoes then branches on typing, switches exact text, and makes checkout reversible', async () => {
    const { hook, session, options } = setup(); await settle();
    act(() => { session.replace('first'); }); const first = hook.current.tree!.currentId;
    act(() => { hook.current.command('undo'); }); expect(session.snapshot().source).toBe('root');
    act(() => { session.replace('second'); }); const second = hook.current.tree!.currentId;
    expect(hook.current.tree!.siblings()).toHaveLength(2);
    act(() => { hook.current.command('previous'); }); expect(session.snapshot().source).toBe('first');
    act(() => { hook.current.command('next'); }); expect(session.snapshot().source).toBe('second');
    act(() => { hook.current.command('checkout', first); }); expect(session.snapshot().source).toBe('first');
    act(() => { hook.current.command('undo'); }); expect(hook.current.tree!.currentId).toBe(second);
    act(() => { hook.current.command('redo'); }); expect(session.snapshot().source).toBe('first');
    expect(hook.current.tree!.size).toBe(3);
    expect(options.onNavigate).toHaveBeenCalled(); hook.unmount();
  });
  it('records visual, review, comment and initial migration changes, but not saving/diagnostics/navigation', async () => {
    const session = new DocumentSession(workspacePath('a.md'), 'legacy'); session.replace('clean', 'system');
    const { options, hook: initial } = setup('legacy'); initial.unmount();
    const hook = mountHook(useDocumentHistory, { ...options, session }); await settle();
    expect(hook.current.tree!.textAt('h0')).toBe('legacy'); expect(hook.current.tree!.text).toBe('clean');
    act(() => { session.replace('visual', 'visual'); session.replace('review', 'review'); session.replace('comment', 'comment'); session.markSaved(); session.setDiagnostics([]); });
    expect(hook.current.tree!.allNodes.map((node) => node.origin)).toEqual(['restore', 'restore', 'visual', 'review', 'comment']);
    const count = hook.current.tree!.size; act(() => { hook.current.command('undo'); });
    expect(hook.current.tree!.size).toBe(count); expect(session.snapshot().source).toBe('review'); hook.unmount();
  });
  it('debounces, flushes pagehide, and reloads the saved tree/current node', async () => {
    vi.useFakeTimers(); const { hook, session, options, backend } = setup(); await settle();
    act(() => { session.replace('saved'); }); const current = hook.current.tree!.currentId;
    expect(backend.save).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); expect(backend.save).toHaveBeenCalledTimes(1);
    act(() => { hook.current.star(current); });
    await act(async () => { window.dispatchEvent(new Event('pagehide')); await Promise.resolve(); });
    expect(backend.save).toHaveBeenCalledTimes(2); hook.unmount();
    const next = new DocumentSession(workspacePath('a.md'), 'saved');
    const restored = mountHook(useDocumentHistory, { ...options, session: next }); await settle();
    expect(restored.current.tree!.currentId).toBe(current); expect(restored.current.tree!.get(current).starred).toBe(true);
    act(() => { restored.current.command('undo'); }); expect(next.snapshot().source).toBe('root'); restored.unmount();
  });
  it('attaches changed disk contents without replacing the open document', async () => {
    const tree = new UndoTree('old'); tree.record({ from: 3, to: 3, insert: '!' }, { origin: 'source' });
    const { hook, session } = setup('disk', tree.toJSON()); await settle();
    expect(session.snapshot().source).toBe('disk'); expect(hook.current.tree!.current.origin).toBe('external');
    act(() => { hook.current.command('undo'); }); expect(session.snapshot().source).toBe('old!'); hook.unmount();
  });
  it('buffers edits while storage loads and never blocks typing or overwrites the latest source', async () => {
    const pending = deferred<unknown>(); const old = new UndoTree('root'); old.record({ from: 4, to: 4, insert: '!' }, { origin: 'review' });
    const session = new DocumentSession(workspacePath('a.md'), 'root');
    const backend: HistoryBackend = { load: () => pending.promise, save: vi.fn().mockResolvedValue(undefined) };
    const hook = mountHook(useDocumentHistory, { session, workspaceId: 'project', backend, setNotice: vi.fn(), onNavigate: vi.fn() });
    act(() => { session.replace('typed'); }); expect(session.snapshot().source).toBe('typed');
    act(() => { expect(hook.current.command('undo')).toBe(false); });
    await act(async () => { pending.resolve(old.toJSON()); await pending.promise; });
    expect(hook.current.ready).toBe(true); expect(hook.current.tree!.text).toBe('typed'); expect(hook.current.tree!.size).toBe(3);
    act(() => { hook.current.command('undo'); }); expect(session.snapshot().source).toBe('root'); hook.unmount();
  });
  it('finishes a late restore before reopening the same project/file', async () => {
    const pending = deferred<unknown>(); let value: unknown; let loads = 0;
    const backend: HistoryBackend = { load: () => ++loads === 1 ? pending.promise : Promise.resolve(value), save: (_key, data) => { value = structuredClone(data); return Promise.resolve(); } };
    const first = new DocumentSession(workspacePath('a.md'), 'root');
    const options = { session: first, workspaceId: 'project', backend, setNotice: vi.fn(), onNavigate: vi.fn() };
    const hook = mountHook(useDocumentHistory, options);
    act(() => { first.replace('first'); }); hook.unmount();
    const next = mountHook(useDocumentHistory, { ...options, session: new DocumentSession(workspacePath('a.md'), 'first') });
    await act(async () => { pending.resolve(undefined); await pending.promise; }); await settle();
    expect(next.current.ready).toBe(true); expect(next.current.tree!.textAt('h0')).toBe('root'); expect(next.current.tree!.text).toBe('first'); next.unmount();
  });
  it('falls back quietly for corrupt or unavailable storage and keeps editing', async () => {
    const { hook, session, options } = setup('root', { version: 99 }); await settle();
    expect(options.setNotice).toHaveBeenCalledOnce();
    act(() => { session.replace('new'); hook.current.command('undo'); }); expect(session.snapshot().source).toBe('root'); hook.unmount();
    const backend: HistoryBackend = { load: vi.fn().mockRejectedValue(new Error('disabled')), save: vi.fn().mockRejectedValue(new Error('quota')) };
    const next = mountHook(useDocumentHistory, { ...options, backend }); await settle(); expect(next.current.ready).toBe(true); next.unmount(); await settle();
  });
  it('isolates projects/files and flushes the previous session when switching', async () => {
    const { hook, session, options, backend } = setup(); await settle();
    act(() => { session.replace('project one'); });
    const other = new DocumentSession(workspacePath('a.md'), 'project two');
    hook.render({ ...options, session: other, workspaceId: 'other' }); await settle();
    expect(hook.current.tree!.text).toBe('project two'); expect(backend.load).toHaveBeenLastCalledWith(historyKey('other', 'a.md'));
    expect(backend.save).toHaveBeenCalledWith(historyKey('project', 'a.md'), expect.anything());
    hook.unmount();
  });
});

describe('history shortcuts', () => {
  it('supports platform undo/redo and branch keys, respecting prevented and composing events', () => {
    expect(isHistoryShortcut(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }))).toBe('undo');
    expect(isHistoryShortcut(new KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: true }))).toBe('redo');
    expect(isHistoryShortcut(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true }))).toBe('redo');
    expect(isHistoryShortcut(new KeyboardEvent('keydown', { code: 'BracketLeft', altKey: true }))).toBe('previous');
    expect(isHistoryShortcut(new KeyboardEvent('keydown', { code: 'BracketRight', altKey: true }))).toBe('next');
    const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, cancelable: true }); event.preventDefault();
    expect(isHistoryShortcut(event)).toBeUndefined();
    expect(isHistoryShortcut(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, isComposing: true }))).toBeUndefined();
  });
  it('leaves text inputs and active ProseMirror blocks alone', () => {
    for (const host of [document.createElement('input'), document.createElement('textarea'), Object.assign(document.createElement('div'), { className: 'ProseMirror' })]) {
      let result: unknown = 'unhandled'; host.addEventListener('keydown', (event) => { result = isHistoryShortcut(event as KeyboardEvent); });
      host.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true })); expect(result).toBeUndefined();
    }
  });
});
