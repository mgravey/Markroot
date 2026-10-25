import { useEffect, useRef, useState } from 'react';
import type { DocumentSession } from '@markroot/document';
import { IndexedDBHistoryBackend, UndoTree, historyKey, loadHistory, saveHistory, textEdit, type HistoryBackend, type HistoryOrigin } from '@markroot/history';
import { useEvent } from './useEvent.js';

const browserHistory = new IndexedDBHistoryBackend();
// Reopening a file waits for a disposed session's pending restore and final flush.
const restores = new WeakMap<HistoryBackend, Map<string, Promise<void>>>();
interface Options {
  session: DocumentSession | undefined;
  workspaceId: string | undefined;
  backend?: HistoryBackend;
  setNotice(notice: string): void;
  onNavigate(position: number): void;
}
interface LiveHistory { session: DocumentSession; tree: UndoTree; ready: boolean; changed(): void; returnTo?: string; forwardTo?: string }

/** Session events, rather than editor events, capture every source/visual/review rewrite. */
export function useDocumentHistory({ session, workspaceId, backend = browserHistory, setNotice, onNavigate }: Options) {
  const live = useRef<LiveHistory | undefined>(undefined);
  const [state, setState] = useState<{ session: DocumentSession; tree: UndoTree; revision: number; ready: boolean }>();
  const notify = useEvent(setNotice);
  const navigateCursor = useEvent(onNavigate);
  useEffect(() => {
    if (!session) { live.current = undefined; setState(undefined); return; }
    let disposed = false; let timer: ReturnType<typeof setTimeout> | undefined; let warned = false;
    const key = workspaceId ? historyKey(workspaceId, session.path) : undefined;
    const pending: { text: string; origin: HistoryOrigin; time: number }[] = [];
    const warn = () => { if (!warned && !disposed) { warned = true; notify('History could not be restored or saved locally. Editing can continue.'); } };
    const flush = () => {
      clearTimeout(timer);
      if (key && controller.ready) void saveHistory(backend, key, controller.tree).catch(warn);
    };
    const changed = () => {
      if (!disposed) setState((previous) => ({ session, tree: controller.tree, ready: controller.ready, revision: (previous?.revision ?? 0) + 1 }));
      clearTimeout(timer); if (controller.ready) timer = setTimeout(flush, 1000);
    };
    const controller: LiveHistory = { session, tree: new UndoTree(session.initialSource), ready: false, changed };
    live.current = controller;
    const unsubscribe = session.subscribe((snapshot, edit) => {
      if (edit?.origin === 'history') return;
      const before = controller.tree.text;
      if (snapshot.source === before) return; // markSaved and diagnostics never add versions.
      const record = { text: snapshot.source, origin: edit?.origin ?? 'restore', time: Date.now() };
      if (!controller.ready) pending.push(record);
      controller.tree.record(textEdit(before, record.text), record);
      delete controller.returnTo; delete controller.forwardTo;
      changed();
    });
    changed();
    let finishRestore!: () => void;
    let previousRestore: Promise<void> | undefined;
    let restoresByKey = restores.get(backend);
    if (!restoresByKey) { restoresByKey = new Map(); restores.set(backend, restoresByKey); }
    const restored = new Promise<void>((resolve) => { finishRestore = resolve; });
    if (key) { previousRestore = restoresByKey.get(key); restoresByKey.set(key, restored); }
    void (async () => {
      try {
        await previousRestore;
        const saved = key ? await loadHistory(backend, key) : undefined;
        if (saved !== undefined) {
          const tree = UndoTree.fromJSON(saved);
          tree.attachExternal(session.initialSource);
          for (const record of pending) tree.record(textEdit(tree.text, record.text), record);
          controller.tree = tree;
        }
      } catch { warn(); }
      controller.ready = true;
      if (disposed) flush(); else changed();
      finishRestore(); if (key && restoresByKey.get(key) === restored) restoresByKey.delete(key);
    })();
    const hide = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush); document.addEventListener('visibilitychange', hide);
    return () => {
      disposed = true; unsubscribe(); clearTimeout(timer); flush();
      window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', hide);
      if (live.current === controller) live.current = undefined;
    };
  }, [session, workspaceId, backend, notify]);

  const command = useEvent((action: 'undo' | 'redo' | 'previous' | 'next' | 'checkout', id?: string) => {
    const controller = live.current;
    if (!controller?.ready || controller.session !== session) return false;
    const { tree } = controller; const before = tree.text; const previousId = tree.currentId;
    if (action === 'checkout' && id) { controller.returnTo = previousId; delete controller.forwardTo; tree.checkout(id); }
    else if (action === 'undo' && controller.returnTo) { tree.checkout(controller.returnTo); delete controller.returnTo; controller.forwardTo = previousId; }
    else if (action === 'redo' && controller.forwardTo) { tree.checkout(controller.forwardTo); delete controller.forwardTo; controller.returnTo = previousId; }
    else if (action === 'undo') tree.undo();
    else if (action === 'redo') tree.redo();
    else if (action === 'previous') { tree.prevBranch(); delete controller.returnTo; delete controller.forwardTo; }
    else if (action === 'next') { tree.nextBranch(); delete controller.returnTo; delete controller.forwardTo; }
    const after = tree.text;
    if (before !== after) {
      const edit = textEdit(before, after); const current = controller.session.snapshot();
      controller.session.apply({ ...edit, origin: 'history', baseRevision: current.revision });
      navigateCursor(edit.from + edit.insert.length);
    }
    controller.changed(); return true;
  });
  const star = useEvent((id: string) => { const controller = live.current; if (controller && controller.session === session) { controller.tree.star(id); controller.changed(); } });
  return { tree: state && state.session === session ? state.tree : undefined, ready: Boolean(state && state.session === session && state.ready), command, star };
}

/** Bubble after ProseMirror/CodeMirror. Text inputs keep their own native undo. */
export function isHistoryShortcut(event: KeyboardEvent): 'undo' | 'redo' | 'previous' | 'next' | undefined {
  if (event.defaultPrevented || event.isComposing) return undefined;
  const target = event.target as Element | null;
  if (target?.closest?.('input, textarea, .ProseMirror, [contenteditable="true"]:not(.cm-content)')) return undefined;
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && !event.altKey) {
    if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
    if (key === 'y' && !event.shiftKey) return 'redo';
  }
  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    if (event.code === 'BracketLeft' || key === '[') return 'previous';
    if (event.code === 'BracketRight' || key === ']') return 'next';
  }
  return undefined;
}
