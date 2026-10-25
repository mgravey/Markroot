import { diffChars, diffWordsWithSpace, type Change } from 'diff';
import { MarkrootError, type AuthorIdentity, type SourceRange } from '@markroot/core';

export type ReviewDecision = 'pending' | 'accept' | 'reject';
export interface ReviewSegment { readonly value: string; readonly kind: 'equal' | 'insert' | 'delete' }
export interface ReviewChange {
  readonly id: string;
  readonly baseRange: SourceRange;
  readonly compareRange: SourceRange;
  readonly baseText: string;
  readonly compareText: string;
  readonly segments: readonly ReviewSegment[];
  readonly decision: ReviewDecision;
  readonly authors: readonly AuthorIdentity[];
}
interface ReviewPiece { readonly common?: string; readonly changeId?: string }
export interface ReviewDraft {
  readonly baseFingerprint: string;
  readonly base: string;
  readonly compare: string;
  readonly changes: readonly ReviewChange[];
  readonly pieces: readonly ReviewPiece[];
  /** The word diff exceeded the time/edit budget; there are no inline changes to decide. */
  readonly tooLarge?: boolean;
}
export interface ReviewDraftOptions {
  /** Milliseconds before the word diff gives up (diff's `timeout`). */
  readonly timeout?: number;
  /** Maximum edit distance before the word diff gives up (diff's `maxEditLength`). */
  readonly maxEditLength?: number;
}
export interface ReviewPresentation {
  readonly current: string;
  readonly base: string;
  readonly ranges: ReadonlyMap<string, SourceRange>;
}

export function createReviewDraft(base: string, compare: string, baseFingerprint: string, attribution: ReadonlyMap<string, readonly AuthorIdentity[]> = new Map(), options: ReviewDraftOptions = {}): ReviewDraft {
  const limits = { ...(options.timeout !== undefined ? { timeout: options.timeout } : {}), ...(options.maxEditLength !== undefined ? { maxEditLength: options.maxEditLength } : {}) };
  const parts = 'timeout' in limits || 'maxEditLength' in limits ? diffWordsWithSpace(base, compare, limits as { timeout: number }) : diffWordsWithSpace(base, compare);
  if (!parts) return { baseFingerprint, base, compare, changes: [], pieces: [], tooLarge: true };
  const groups: Array<{ readonly common: string } | { readonly parts: Change[] }> = [];
  for (const part of parts) {
    const last = groups.at(-1);
    if (!part.added && !part.removed) groups.push({ common: part.value });
    else if (last && 'parts' in last) last.parts.push(part);
    else groups.push({ parts: [part] });
  }
  const changes: ReviewChange[] = [];
  const pieces: ReviewPiece[] = [];
  const seen = new Map<string, number>();
  let baseOffset = 0;
  let compareOffset = 0;
  groups.forEach((group, index) => {
    if ('common' in group) {
      pieces.push({ common: group.common });
      baseOffset += group.common.length;
      compareOffset += group.common.length;
      return;
    }
    const baseText = group.parts.filter((part) => part.removed).map((part) => part.value).join('');
    const compareText = group.parts.filter((part) => part.added).map((part) => part.value).join('');
    // Content + surrounding context, not position: ids survive unrelated edits elsewhere; repeats get an ordinal.
    const before = commonText(groups[index - 1]).slice(-16);
    const after = commonText(groups[index + 1]).slice(0, 16);
    const key = fingerprint(`${before}\u0000${baseText}\u0000${compareText}\u0000${after}`);
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    const id = `c-${key}${occurrence > 1 ? `-${occurrence}` : ''}`;
    const granular = Math.max(baseText.length, compareText.length) <= 128 ? diffChars(baseText, compareText) : group.parts;
    changes.push({
      id,
      baseRange: { from: baseOffset, to: baseOffset + baseText.length },
      compareRange: { from: compareOffset, to: compareOffset + compareText.length },
      baseText,
      compareText,
      segments: granular.map(toSegment),
      decision: 'pending',
      authors: attribution.get(id) ?? [],
    });
    pieces.push({ changeId: id });
    baseOffset += baseText.length;
    compareOffset += compareText.length;
  });
  return { baseFingerprint, base, compare, changes, pieces };
}

export function decideChange(draft: ReviewDraft, changeId: string, decision: Exclude<ReviewDecision, 'pending'>): ReviewDraft {
  let found = false;
  const changes = draft.changes.map((change) => {
    if (change.id !== changeId) return change;
    found = true;
    return { ...change, decision };
  });
  if (!found) throw new Error(`Review change not found: ${changeId}`);
  return { ...draft, changes };
}

export function materializeReview(draft: ReviewDraft): string {
  if (draft.tooLarge) throw new MarkrootError('CONFLICT', 'The comparison is too large to review change by change.');
  const changes = new Map(draft.changes.map((change) => [change.id, change]));
  const pending = draft.changes.filter((change) => change.decision === 'pending');
  if (pending.length) throw new MarkrootError('CONFLICT', `${pending.length} review changes still need a decision.`);
  return draft.pieces.map((piece) => {
    if (piece.common !== undefined) return piece.common;
    const change = changes.get(piece.changeId!)!;
    return change.decision === 'accept' ? change.compareText : change.baseText;
  }).join('');
}

export function materializeReviewPresentation(draft: ReviewDraft): ReviewPresentation {
  if (draft.tooLarge) return { current: draft.compare, base: draft.base, ranges: new Map() };
  const changes = new Map(draft.changes.map((change) => [change.id, change]));
  const current: string[] = [];
  const base: string[] = [];
  const ranges = new Map<string, SourceRange>();
  let currentOffset = 0;
  for (const piece of draft.pieces) {
    if (piece.common !== undefined) {
      current.push(piece.common);
      base.push(piece.common);
      currentOffset += piece.common.length;
      continue;
    }
    const change = changes.get(piece.changeId!)!;
    const currentText = change.decision === 'reject' ? change.baseText : change.compareText;
    const baseText = change.decision === 'pending' ? change.baseText : currentText;
    ranges.set(change.id, { from: currentOffset, to: currentOffset + currentText.length });
    current.push(currentText);
    base.push(baseText);
    currentOffset += currentText.length;
  }
  return { current: current.join(''), base: base.join(''), ranges };
}

/** Maps a source offset in the compared branch to the live review presentation. */
export function mapReviewCompareOffset(draft: ReviewDraft, offset: number): number {
  return mapReviewOffset(draft, offset, 'compare');
}

/** Maps a source offset in the live review presentation back to the compared branch. */
export function mapReviewCurrentOffset(draft: ReviewDraft, offset: number): number {
  return mapReviewOffset(draft, offset, 'current');
}

function mapReviewOffset(draft: ReviewDraft, requestedOffset: number, origin: 'compare' | 'current'): number {
  if (draft.tooLarge) return Math.max(0, Math.min(requestedOffset, draft.compare.length));
  const changes = new Map(draft.changes.map((change) => [change.id, change]));
  const currentLength = draft.pieces.reduce((length, piece) => {
    if (piece.common !== undefined) return length + piece.common.length;
    const change = changes.get(piece.changeId!)!;
    return length + (change.decision === 'reject' ? change.baseText.length : change.compareText.length);
  }, 0);
  const offset = Math.max(0, Math.min(requestedOffset, origin === 'compare' ? draft.compare.length : currentLength));
  let compareOffset = 0;
  let currentOffset = 0;

  for (const piece of draft.pieces) {
    if (piece.common !== undefined) {
      const originStart = origin === 'compare' ? compareOffset : currentOffset;
      if (offset <= originStart + piece.common.length) {
        return (origin === 'compare' ? currentOffset : compareOffset) + offset - originStart;
      }
      compareOffset += piece.common.length;
      currentOffset += piece.common.length;
      continue;
    }

    const change = changes.get(piece.changeId!)!;
    const compareLength = change.compareText.length;
    const presentedLength = (change.decision === 'reject' ? change.baseText : change.compareText).length;
    const originStart = origin === 'compare' ? compareOffset : currentOffset;
    const originLength = origin === 'compare' ? compareLength : presentedLength;
    if (offset <= originStart + originLength) {
      const targetStart = origin === 'compare' ? currentOffset : compareOffset;
      const targetLength = origin === 'compare' ? presentedLength : compareLength;
      if (!originLength) return targetStart;
      return targetStart + Math.round((offset - originStart) / originLength * targetLength);
    }
    compareOffset += compareLength;
    currentOffset += presentedLength;
  }
  return origin === 'compare' ? currentOffset : compareOffset;
}

function commonText(group: { readonly common: string } | { readonly parts: Change[] } | undefined): string { return group && 'common' in group ? group.common : ''; }
function toSegment(part: Change): ReviewSegment {
  return { value: part.value, kind: part.added ? 'insert' : part.removed ? 'delete' : 'equal' };
}
function fingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(36);
}
