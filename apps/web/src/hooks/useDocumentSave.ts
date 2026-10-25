import { useRef, type RefObject } from 'react';
import { commentRevision } from '@markroot/comments';
import type { DocumentSession, DocumentSnapshot } from '@markroot/document';
import type { IsomorphicGitRepository } from '@markroot/git';
import { deletePendingSession } from '@markroot/settings';
import type { GuardedWorkspace } from '@markroot/workspace';
import type { useComments } from './useComments.js';
import { useEvent } from './useEvent.js';

interface Options {
  workspace: GuardedWorkspace | undefined;
  session: DocumentSession | undefined;
  activeSession: RefObject<DocumentSession | undefined>;
  git: IsomorphicGitRepository | undefined;
  commentState: Pick<ReturnType<typeof useComments>, 'legacy' | 'store' | 'adopt'>;
  documentRequest: RefObject<number>;
  fileVersionRef: RefObject<string | undefined>;
  pendingWorkspace: string | { id: string; name: string };
  setFileVersion(version: string | undefined): void;
  setNotice(notice: string | undefined): void;
  reportError(error: unknown): void;
  onCitationsChanged(): Promise<void>;
  refreshStatus(): void;
}

/** Serializes saves, retaining the captured document and rejecting stale completion effects. */
export function useDocumentSave({ workspace, session, activeSession, git, commentState, documentRequest, fileVersionRef, pendingWorkspace, setFileVersion, setNotice, reportError, onCitationsChanged, refreshStatus }: Options) {
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  // Saves run one at a time so overlapping autosave, Cmd+S and comment saves never race on the file version.
  function saveDocument(): Promise<DocumentSnapshot | undefined> {
    const context = documentRequest.current;
    const write = () => context === documentRequest.current ? writeDocument(context) : undefined;
    const queued = saveQueue.current.then(write, write);
    saveQueue.current = queued;
    return queued;
  }

  async function writeDocument(context: number): Promise<DocumentSnapshot | undefined> {
    if (!workspace || !session || session !== activeSession.current) return undefined;
    const current = session.snapshot();
    const migration = commentState.legacy.current;
    let brokenNotice: string | undefined;
    try {
      if (!current.dirty && !migration.length) {
        const stat = await workspace.stat(current.path);
        // Metadata misses same-size external edits. A byte read preserves the guarded-write baseline.
        const source = new TextDecoder().decode(await workspace.readBytes(current.path));
        if (context !== documentRequest.current || session !== activeSession.current || session.snapshot().revision !== current.revision) return undefined;
        if ((fileVersionRef.current !== undefined && stat.version !== fileVersionRef.current) || source !== current.source) {
          setNotice(`${current.path} changed outside Markroot. Reload or compare before saving.`);
          return undefined;
        }
        return current;
      }
      if (migration.length && commentState.store) {
        const commit = git ? (await git.history(1).catch(() => []))[0]?.oid ?? null : null;
        await commentState.store.importLegacy(current.path, migration, await commentRevision(current.source, commit));
        // Validate persisted sidecars before removing legacy data.
        const { broken } = await commentState.store.loadWithIssues(current.path);
        if (broken.some((item) => !item.document || item.document === current.path || migration.some((thread) => thread.id === item.id))) throw new Error('Some comment files could not be read back; legacy comments were kept in the document.');
      }
      if (context !== documentRequest.current) return undefined;
      const stat = await workspace.writeFileGuarded(current.path, current.source, fileVersionRef.current);
      if (context !== documentRequest.current) return undefined;
      fileVersionRef.current = stat.version;
      if (migration.length && commentState.store) {
        const loaded = await commentState.store.loadWithIssues(current.path);
        if (context !== documentRequest.current) return undefined;
        brokenNotice = commentState.adopt(loaded.threads, [], loaded.broken, current.path);
      }
      setFileVersion(stat.version);
      session.markSaved(current.revision);
      if (!session.snapshot().dirty) await deletePendingSession(pendingWorkspace, current.path).catch(() => undefined);
      if (/\.(?:bib|bibtex)$/i.test(current.path)) await onCitationsChanged();
      if (context !== documentRequest.current) return undefined;
      setNotice(brokenNotice ? `Saved ${current.path}. ${brokenNotice}` : `Saved ${current.path}.`);
    } catch (error) { reportError(error); return undefined; }
    // A status refresh failure is not a save failure.
    refreshStatus();
    return current;
  }

  return useEvent(saveDocument);
}
