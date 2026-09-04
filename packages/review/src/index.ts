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
}

export function createReviewDraft(base: string, compare: string, baseFingerprint: string, attribution: ReadonlyMap<string, readonly AuthorIdentity[]> = new Map()): ReviewDraft {
  const parts = diffWordsWithSpace(base, compare);
  const changes: ReviewChange[] = [];
  const pieces: ReviewPiece[] = [];
  let baseOffset = 0;
  let compareOffset = 0;
  let pending: Change[] = [];
  const flush = () => {
    if (!pending.length) return;
    const baseText = pending.filter((part) => part.removed).map((part) => part.value).join('');
    const compareText = pending.filter((part) => part.added).map((part) => part.value).join('');
    const id = `c-${changes.length + 1}-${fingerprint(`${baseOffset}:${compareOffset}:${baseText}:${compareText}`)}`;
    const granular = Math.max(baseText.length, compareText.length) <= 128 ? diffChars(baseText, compareText) : pending;
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
    pending = [];
  };
  for (const part of parts) {
    if (!part.added && !part.removed) {
      flush();
      pieces.push({ common: part.value });
      baseOffset += part.value.length;
      compareOffset += part.value.length;
    } else pending.push(part);
  }
  flush();
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
  const changes = new Map(draft.changes.map((change) => [change.id, change]));
  const pending = draft.changes.filter((change) => change.decision === 'pending');
  if (pending.length) throw new MarkrootError('CONFLICT', `${pending.length} review changes still need a decision.`);
  return draft.pieces.map((piece) => {
    if (piece.common !== undefined) return piece.common;
    const change = changes.get(piece.changeId!)!;
    return change.decision === 'accept' ? change.compareText : change.baseText;
  }).join('');
}

function toSegment(part: Change): ReviewSegment {
  return { value: part.value, kind: part.added ? 'insert' : part.removed ? 'delete' : 'equal' };
}
function fingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(36);
}
