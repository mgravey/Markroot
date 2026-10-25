import { useEffect, useMemo, useRef, useState } from 'react';
import type { AuthorIdentity, SourceRange, WorkspacePath } from '@markroot/core';
import type { DocumentSession, DocumentSnapshot } from '@markroot/document';
import { CommentStore, commentRevision, createSelector, locateComments, type BrokenCommentThread, type CommentThread } from '@markroot/comments';
import type { IsomorphicGitRepository } from '@markroot/git';
import type { GuardedWorkspace } from '@markroot/workspace';
import { useEvent } from './useEvent.js';

type CommentOperation = (store: CommentStore, current: DocumentSnapshot, revision: Awaited<ReturnType<typeof commentRevision>>) => Promise<void>;

interface Options {
  readonly workspace: GuardedWorkspace | undefined;
  readonly session: DocumentSession | undefined;
  readonly snapshot: DocumentSnapshot | undefined;
  readonly selection: SourceRange;
  /** Comments are read-only while a branch review is open. */
  readonly reviewing: boolean;
  readonly git: IsomorphicGitRepository | undefined;
  readonly profile: AuthorIdentity;
  readonly saveDocument: () => Promise<DocumentSnapshot | undefined>;
  readonly setNotice: (notice: string | undefined) => void;
  readonly reportError: (error: unknown) => void;
  readonly onCommentsWritten: () => void;
}

/** Sidecar comment threads of the open document, including legacy embedded comments awaiting migration. */
export function useComments({ workspace, session, snapshot, selection, reviewing, git, profile, saveDocument, setNotice, reportError, onCommentsWritten }: Options) {
  const store = useMemo(() => workspace ? new CommentStore(workspace) : undefined, [workspace]);
  const [threads, setThreads] = useState<readonly CommentThread[]>([]);
  const [body, setBody] = useState('');
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [activeId, setActiveId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const writeBusy = useRef(false);
  /** Embedded comments parsed from the open file; they move to sidecars on the next save. */
  const legacy = useRef<readonly CommentThread[]>([]);
  const loadRequest = useRef(0);
  const refreshRequest = useRef(0);
  // Last broken-comment report shown, so focus reloads do not repeat the same notice.
  const brokenShown = useRef('');
  const located = useMemo(() => snapshot ? locateComments(snapshot.source, threads) : undefined, [snapshot, threads]);

  /** Starts loading another document's comments; earlier loads become stale. */
  const beginLoad = useEvent(() => ++loadRequest.current);
  const isCurrentLoad = useEvent((request: number) => request === loadRequest.current);
  /** Shows loaded threads (plus pending legacy ones) and returns a notice for unreadable threads, if any. */
  const adopt = useEvent((sidecars: readonly CommentThread[], migration: readonly CommentThread[], broken: readonly BrokenCommentThread[], path: WorkspacePath) => {
    legacy.current = migration;
    setThreads([...sidecars, ...migration.filter((thread) => !sidecars.some((item) => item.id === thread.id))]);
    const notice = brokenCommentsNotice(broken, path);
    brokenShown.current = notice ?? '';
    return notice;
  });
  const clear = useEvent(() => {
    loadRequest.current += 1;
    legacy.current = [];
    setThreads([]);
    setActiveId(undefined);
  });

  const reload = useEvent(async () => {
    if (!store || !session || legacy.current.length || writeBusy.current) return;
    const context = loadRequest.current;
    const request = ++refreshRequest.current;
    const path = session.snapshot().path;
    const loaded = await store.loadWithIssues(path);
    if (context !== loadRequest.current || request !== refreshRequest.current) return;
    setThreads(loaded.threads);
    const notice = brokenCommentsNotice(loaded.broken, path);
    if (notice && notice !== brokenShown.current) setNotice(notice);
    brokenShown.current = notice ?? '';
  });
  const reportReloadError = useEvent(reportError);

  useEffect(() => {
    const refresh = () => { void reload().catch(reportReloadError); };
    window.addEventListener('focus', refresh);
    return () => { window.removeEventListener('focus', refresh); loadRequest.current += 1; };
  }, [store, session, reload, reportReloadError]);

  async function change(operation: CommentOperation) {
    if (!store || !workspace || !session || writeBusy.current || reviewing) return;
    writeBusy.current = true;
    loadRequest.current += 1;
    setBusy(true);
    try {
      // New anchors and resolutions refer to text that has actually been persisted.
      const current = session.snapshot().dirty ? await saveDocument() : session.snapshot();
      if (!current) return;
      if (await workspace.readFile(current.path) !== current.source) throw new Error('The document changed outside Markroot. Reload it before commenting.');
      const commit = git ? (await git.history(1).catch(() => []))[0]?.oid ?? null : null;
      await operation(store, current, await commentRevision(current.source, commit));
      const loaded = await store.loadWithIssues(current.path);
      setThreads(loaded.threads);
      const notice = brokenCommentsNotice(loaded.broken, current.path);
      brokenShown.current = notice ?? '';
      setNotice(`Comment saved. Stage its YAML files in Git to include it in a commit.${notice ? ` ${notice}` : ''}`);
      onCommentsWritten();
    } catch (error) { reportError(error); }
    finally { writeBusy.current = false; setBusy(false); }
  }

  const add = useEvent(async () => {
    if (!snapshot || selection.to <= selection.from || !body.trim()) return;
    const selectedBlock = snapshot.blocks.find((block) => selection.from >= block.from && selection.to <= block.to);
    const blockLevel = !selectedBlock || ['frontmatter', 'raw', 'code'].includes(selectedBlock.kind);
    const range = blockLevel && selectedBlock ? { from: selectedBlock.from, to: selectedBlock.to } : selection;
    await change(async (commentStore, current, revision) => {
      const id = await commentStore.create(current.path, current.source, range, body, profile, revision, blockLevel);
      setActiveId(id);
      setBody('');
    });
  });
  const repair = useEvent((id: string) => { void change(async (commentStore, current, revision) => {
    await commentStore.reattach(current.path, id, current.source, selection, revision);
  }); });
  const reply = useEvent((id: string) => { if (!replies[id]?.trim()) return; void change(async (commentStore, current) => {
    await commentStore.reply(current.path, id, replies[id]!, profile);
    setReplies((all) => ({ ...all, [id]: '' }));
  }); });
  const setStatus = useEvent((id: string, status: 'open' | 'resolved') => { void change(async (commentStore, current, revision) => {
    const range = locateComments(current.source, threads).ranges.get(id);
    if (status === 'resolved' && !range) throw new Error('Select the passage and reattach this comment before resolving it.');
    await commentStore.setStatus(current.path, id, status, status === 'resolved' ? { revision, selector: createSelector(current.source, range!), author: profile, at: new Date().toISOString() } : undefined);
  }); });
  const remove = useEvent((id: string) => { if (window.confirm('Delete this comment thread?')) void change(async (commentStore, current) => {
    await commentStore.delete(current.path, id);
    if (activeId === id) setActiveId(undefined);
  }); });

  return { store, located, activeId, setActiveId, body, setBody, replies, setReplies, busy, writeBusy, legacy, beginLoad, isCurrentLoad, adopt, clear, reload, add, repair, reply, setStatus, remove };
}

export function brokenCommentsNotice(broken: readonly BrokenCommentThread[], path: WorkspacePath): string | undefined {
  const relevant = broken.filter((item) => !item.document || item.document === path);
  if (!relevant.length) return undefined;
  const listed = relevant.slice(0, 3).map((item) => `${item.id} (${item.error})`).join('; ');
  return `${relevant.length} comment thread(s) could not be read and are hidden: ${listed}${relevant.length > 3 ? '; …' : ''}. Repair the files under .markroot/comments.`;
}
