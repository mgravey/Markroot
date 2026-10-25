import { documentBlockAt, type DocumentSnapshot } from '@markroot/document';
import type { SourceRange } from '@markroot/core';
import type { DocumentOutlineItem } from '@markroot/rendering';
import { mapReviewCompareOffset, mapReviewCurrentOffset, type ReviewDraft } from '@markroot/review';
import { blockProgress } from '../components/scroll-sync.js';
import type { ScrollStore } from './scroll-store.js';
import { useEvent } from './useEvent.js';

interface Options {
  snapshot: DocumentSnapshot | undefined;
  review: ReviewDraft | undefined;
  reviewPreviewSnapshot: DocumentSnapshot | undefined;
  scroll: ScrollStore;
  setSelection(range: SourceRange): void;
  setSourceCursorTarget(offset: number | undefined): void;
  setRightMode(mode: 'preview'): void;
  setPreviewAnchor(update: (current: Readonly<{ id: string; request: number }> | undefined) => Readonly<{ id: string; request: number }>): void;
}

/** Stable pane callbacks always navigate the currently presented document. */
export function usePaneNavigation({ snapshot, review, reviewPreviewSnapshot, scroll, setSelection, setSourceCursorTarget, setRightMode, setPreviewAnchor }: Options) {
  const selectSource = useEvent((range: SourceRange) => {
    setSelection(range);
    setSourceCursorTarget(undefined);
    const draft = review;
    const navigationSnapshot = draft ? reviewPreviewSnapshot : snapshot;
    const navigationOffset = draft ? mapReviewCurrentOffset(draft, range.from) : range.from;
    const block = navigationSnapshot ? documentBlockAt(navigationSnapshot.blocks, navigationOffset) : undefined;
    if (!block) return;
    scroll.set({ origin: 'source', alignment: 'reveal', target: block.id, progress: blockProgress(navigationOffset, block) });
  });

  const navigateFromRight = useEvent((blockId: string, sourceOffset?: number) => {
    const draft = review;
    const navigationSnapshot = draft ? reviewPreviewSnapshot : snapshot;
    const block = navigationSnapshot?.blocks.find((candidate) => candidate.id === blockId);
    const comparePosition = block ? Math.max(block.from, Math.min(sourceOffset ?? block.from, block.to)) : sourceOffset;
    const position = draft && comparePosition !== undefined ? mapReviewCompareOffset(draft, comparePosition) : comparePosition;
    scroll.set({ origin: 'right', alignment: 'reveal', target: blockId, progress: block && comparePosition !== undefined ? blockProgress(comparePosition, block) : 0 });
    setSourceCursorTarget(undefined);
    if (position !== undefined) window.setTimeout(() => setSourceCursorTarget(position), 0);
  });

  const selectFromRight = useEvent((range: SourceRange) => {
    const draft = review;
    const currentRange = draft
      ? { from: mapReviewCompareOffset(draft, range.from), to: mapReviewCompareOffset(draft, range.to) }
      : range;
    setSelection(currentRange);
    setSourceCursorTarget(undefined);
    const navigationSnapshot = draft ? reviewPreviewSnapshot : snapshot;
    const block = navigationSnapshot ? documentBlockAt(navigationSnapshot.blocks, range.from) : undefined;
    if (!block) return;
    scroll.set({ origin: 'right', alignment: 'reveal', target: block.id, progress: blockProgress(range.from, block) });
  });

  const navigateFromSourceScroll = useEvent((blockId: string, progress: number) => {
    const currentSnapshot = snapshot;
    const sourceBlock = currentSnapshot?.blocks.find((block) => block.id === blockId);
    const currentOffset = sourceBlock
      ? sourceBlock.from + Math.round((sourceBlock.to - sourceBlock.from) * progress)
      : undefined;
    const draft = review;
    const compareOffset = draft && currentOffset !== undefined ? mapReviewCurrentOffset(draft, currentOffset) : currentOffset;
    const navigationSnapshot = draft ? reviewPreviewSnapshot : currentSnapshot;
    const block = navigationSnapshot && compareOffset !== undefined ? documentBlockAt(navigationSnapshot.blocks, compareOffset) : undefined;
    setSourceCursorTarget(undefined);
    scroll.set({ origin: 'source', alignment: 'center', progress: block && compareOffset !== undefined ? blockProgress(compareOffset, block) : progress, target: block?.id ?? blockId });
  });

  const navigateOutline = useEvent((item: DocumentOutlineItem) => {
    setRightMode('preview');
    scroll.set({ origin: 'right', alignment: 'reveal', target: item.blockId, progress: 0 });
    setSourceCursorTarget(undefined);
    window.setTimeout(() => setSourceCursorTarget(item.from), 0);
    setPreviewAnchor((current) => ({ id: item.id, request: (current?.request ?? 0) + 1 }));
  });

  return { selectSource, navigateFromRight, selectFromRight, navigateFromSourceScroll, navigateOutline };
}
