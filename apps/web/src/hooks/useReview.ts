import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { throwIfAborted, type SourceRange, type WorkspacePath } from '@markroot/core';
import { documentBlockAt, DocumentSession, type DocumentSnapshot } from '@markroot/document';
import type { GitCommitSummary, IsomorphicGitRepository } from '@markroot/git';
import { decideChange, materializeReview, materializeReviewPresentation, type ReviewDraft } from '@markroot/review';
import type { GuardedWorkspace } from '@markroot/workspace';
import { blockProgress } from '../components/scroll-sync.js';
import type { EditorTrackChange } from '../editor-track-changes.js';
import type { AttributionVersion } from '../review-attribution.js';
import { attributeReviewChangesInWorker, createReviewDraftInWorker } from '../workers/review-client.js';
import type { ScrollStore } from './scroll-store.js';
import { useEvent } from './useEvent.js';

interface Options {
  readonly git: IsomorphicGitRepository | undefined;
  readonly workspace: GuardedWorkspace | undefined;
  readonly snapshot: DocumentSnapshot | undefined;
  readonly scroll: ScrollStore;
  readonly setSelection: (range: SourceRange) => void;
  readonly setSourceCursorTarget: (offset: number | undefined) => void;
  readonly applySource: (source: string, origin: 'review') => void;
  readonly setNotice: (notice: string | undefined) => void;
  readonly reportError: (error: unknown) => void;
  /** Shows the review UI once a comparison is ready. */
  readonly onOpened: () => void;
  readonly onApplied: () => void;
}

/** Branch comparison as inline tracked changes: diffing and author lookup run in a worker, decisions stay in memory. */
export function useReview({ git, workspace, snapshot, scroll, setSelection, setSourceCursorTarget, applySource, setNotice, reportError, onOpened, onApplied }: Options) {
  const [review, setReview] = useState<ReviewDraft>();
  const [attributionBusy, setAttributionBusy] = useState(false);
  const [activeChangeId, setActiveChangeId] = useState<string>();
  const controller = useRef<AbortController | undefined>(undefined);
  const request = useRef(0);

  useEffect(() => () => { controller.current?.abort(); request.current += 1; }, []);

  const presentation = useMemo(() => review ? materializeReviewPresentation(review) : undefined, [review]);
  const presentedSource = presentation?.current;
  const comparedSource = review?.compare;
  const snapshotPath = snapshot?.path;
  const presentedSnapshot = useMemo(() => presentedSource !== undefined && snapshot ? new DocumentSession(snapshot.path, presentedSource).snapshot() : snapshot, [presentedSource, snapshot]);
  const previewSnapshot = useMemo(() => comparedSource !== undefined && snapshotPath ? new DocumentSession(snapshotPath, comparedSource).snapshot() : undefined, [comparedSource, snapshotPath]);
  const activeChange = review?.changes.find((change) => change.id === activeChangeId) ?? review?.changes[0];
  const activeRange = activeChange ? presentation?.ranges.get(activeChange.id) : undefined;
  const trackChanges = useMemo<readonly EditorTrackChange[] | undefined>(() => {
    if (!review || !presentation) return undefined;
    return review.changes.flatMap((change): readonly EditorTrackChange[] => {
      if (change.decision !== 'pending') return [];
      const range = presentation.ranges.get(change.id);
      if (!range) return [];
      const tracked: EditorTrackChange[] = [];
      let offset = range.from;
      for (const segment of change.segments) {
        if (segment.kind === 'insert') { tracked.push({ kind: 'insert', from: offset, to: offset + segment.value.length, changeId: change.id }); offset += segment.value.length; }
        else if (segment.kind === 'delete') tracked.push({ kind: 'delete', at: offset, value: segment.value, changeId: change.id });
        else offset += segment.value.length;
      }
      return tracked;
    });
  }, [review, presentation]);
  const activeTrackChange = useMemo(() => activeChange ? { id: activeChange.id, range: activeChange.compareRange, baseText: activeChange.baseText } : undefined, [activeChange]);
  const activeSourceTrackChange = useMemo(() => activeChange && activeRange ? { from: activeRange.from, to: activeRange.to, baseText: activeChange.baseText } : undefined, [activeChange, activeRange]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- Compared text and ranges are immutable for a base/compare pair; decisions and author attribution must not rebuild viewer HTML.
  const renderedChanges = useMemo(() => review?.changes.map(({ id, baseText, compareText, compareRange }) => ({ id, baseText, compareText, compareRange })), [review?.base, review?.compare]);
  const renderedDecisions = useMemo(() => review?.changes.map(({ id, decision }) => ({ id, decision })), [review]);

  /** Closes the review and cancels any running diff or author lookup. */
  const reset = useEvent(() => {
    controller.current?.abort();
    controller.current = undefined;
    request.current += 1;
    setAttributionBusy(false);
    setReview(undefined);
    setActiveChangeId(undefined);
  });

  const compare = useEvent(async (ref: string) => {
    if (!git || !snapshot) return;
    if (snapshot.dirty) { setNotice('Save the open document before starting branch review.'); return; }
    // A newer comparison cancels the previous diff and author lookup.
    controller.current?.abort();
    const active = new AbortController();
    controller.current = active;
    const { signal } = active;
    const id = ++request.current;
    const current = () => !signal.aborted && request.current === id;
    setAttributionBusy(false);
    setNotice('Computing branch changes…');
    try {
      const [base, compared, fingerprint] = await Promise.all([
        git.readFileAtRef(snapshot.path, 'HEAD'),
        git.readFileAtRef(snapshot.path, ref),
        git.fingerprint(),
      ]);
      throwIfAborted({ signal });
      const nextReview = await createReviewDraftInWorker(base, compared, fingerprint, { signal });
      if (!current()) return;
      if (nextReview.tooLarge) { setNotice(`The differences between ${ref} and the current branch in ${snapshot.path} are too large to review inline. Compare smaller changes, or merge with Git and resolve the result directly.`); return; }
      if (!nextReview.changes.length) { setNotice(`${ref} has no changes for ${snapshot.path}.`); return; }
      const firstChange = nextReview.changes[0]!;
      const firstRange = materializeReviewPresentation(nextReview).ranges.get(firstChange.id) ?? firstChange.compareRange;
      const reviewSnapshot = new DocumentSession(snapshot.path, compared).snapshot();
      const block = documentBlockAt(reviewSnapshot.blocks, firstChange.compareRange.from);
      setReview(nextReview);
      setActiveChangeId(firstChange.id);
      scroll.set({ origin: 'command', alignment: 'reveal', progress: block ? blockProgress(firstChange.compareRange.from, block) : 0, target: block?.id });
      setSourceCursorTarget(firstRange.from);
      onOpened();
      setAttributionBusy(true);
      setNotice('Review ready. Finding change authors in the background…');
      void attributeReviewChanges(git, snapshot.path, ref, nextReview, signal)
        .then((attribution) => {
          if (!current()) return;
          setReview((draft) => draft && draft.base === base && draft.compare === compared
            ? { ...draft, changes: draft.changes.map((change) => ({ ...change, authors: attribution.get(change.id) ?? change.authors })) }
            : draft);
          setNotice('Branch review ready.');
        })
        .catch((error: unknown) => { if (current()) setNotice(`Review ready; author lookup failed: ${error instanceof Error ? error.message : String(error)}`); })
        .finally(() => { if (request.current === id) setAttributionBusy(false); });
    } catch (error) { if (!signal.aborted) reportError(error); }
  });

  const apply = useEvent(async () => {
    if (!review || !snapshot || !workspace || !git) return;
    const context = request.current;
    try {
      if (await git.fingerprint() !== review.baseFingerprint) throw new Error('Repository state changed after this review started. Reopen the comparison.');
      if (await workspace.readFile(snapshot.path) !== review.base) throw new Error('The working file changed after this review started. Reopen the comparison.');
      if (context !== request.current) return;
      const result = materializeReview(review);
      reset();
      applySource(result, 'review');
      onApplied();
      setNotice('Review decisions applied to the working document. Save to write them.');
    }
    catch (error) { reportError(error); }
  });

  function navigate(draft: ReviewDraft, changeId: string) {
    if (!snapshot) return;
    const change = draft.changes.find((candidate) => candidate.id === changeId);
    if (!change) return;
    const range = materializeReviewPresentation(draft).ranges.get(change.id) ?? change.compareRange;
    const reviewSnapshot = new DocumentSession(snapshot.path, draft.compare).snapshot();
    const block = documentBlockAt(reviewSnapshot.blocks, change.compareRange.from);
    setActiveChangeId(change.id);
    setSelection(range);
    setSourceCursorTarget(undefined);
    window.setTimeout(() => setSourceCursorTarget(range.from), 0);
    if (block) scroll.set({ origin: 'command', alignment: 'reveal', progress: blockProgress(change.compareRange.from, block), target: block.id });
  }

  const select = useEvent((changeId: string) => { if (review) navigate(review, changeId); });

  const decide = useEvent((changeId: string, decision: 'accept' | 'reject') => {
    if (!review) return;
    const decided = decideChange(review, changeId, decision);
    setReview(decided);
    const currentIndex = decided.changes.findIndex((change) => change.id === changeId);
    const next = [...decided.changes.slice(currentIndex + 1), ...decided.changes.slice(0, currentIndex)]
      .find((change) => change.decision === 'pending');
    if (next) {
      setActiveChangeId(next.id);
      window.requestAnimationFrame(() => navigate(decided, next.id));
    }
    else setActiveChangeId(changeId);
  });

  const decideAll = useCallback((decision: 'accept' | 'reject') => {
    setReview((current) => current ? { ...current, changes: current.changes.map((change) => ({ ...change, decision })) } : current);
  }, []);

  return { review, presentation, presentedSnapshot, previewSnapshot, attributionBusy, activeChangeId, trackChanges, activeTrackChange, activeSourceTrackChange, renderedChanges, renderedDecisions, reset, compare, apply, select, decide, decideAll };
}

/** Reads up to 50 historical versions one at a time, then attributes changes off the main thread. */
async function attributeReviewChanges(git: IsomorphicGitRepository, path: WorkspacePath, ref: string, draft: ReviewDraft, signal: AbortSignal): Promise<ReadonlyMap<string, readonly GitCommitSummary['author'][]>> {
  const commits = [...await git.history(50, ref)].reverse();
  const versions: AttributionVersion[] = [];
  for (const entry of commits) {
    throwIfAborted({ signal });
    versions.push({ author: entry.author, content: await git.readFileAtRef(path, entry.oid).catch(() => '') });
  }
  const changes = draft.changes.map(({ id, baseText, compareText, baseRange, compareRange }) => ({ id, baseText, compareText, baseRange, compareRange }));
  return attributeReviewChangesInWorker({ base: draft.base, compare: draft.compare, changes }, versions, { signal });
}
