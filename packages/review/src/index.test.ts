import { describe, expect, it } from 'vitest';
import { createReviewDraft, decideChange, mapReviewCompareOffset, mapReviewCurrentOffset, materializeReview, materializeReviewPresentation } from './index.js';

describe('review draft', () => {
  it('applies explicit accept and reject decisions', () => {
    const draft = createReviewDraft('A small draft.', 'A concise draft!', 'base');
    const decided = draft.changes.reduce((current, change, index) => decideChange(current, change.id, index === 0 ? 'accept' : 'reject'), draft);
    expect(() => materializeReview(draft)).toThrow(/decision/);
    expect(materializeReview(decided)).toContain('concise');
  });

  it('applies decisions in the live presentation and leaves only pending changes marked', () => {
    const draft = createReviewDraft('Keep old and stay.', 'Keep new and go.', 'base');
    const accepted = decideChange(draft, draft.changes[0]!.id, 'accept');
    const presentation = materializeReviewPresentation(accepted);
    expect(presentation.current).toBe('Keep new and go.');
    expect(presentation.base).toBe('Keep new and stay.');
    expect(presentation.ranges.get(draft.changes[0]!.id)).toEqual({ from: 5, to: 8 });
  });

  it('maps offsets between compared and decided presentation text', () => {
    const draft = createReviewDraft('Before old after.', 'Before much-newer after.', 'base');
    const change = draft.changes[0]!;
    const rejected = decideChange(draft, change.id, 'reject');
    const compareAfter = draft.compare.indexOf(' after');
    const currentAfter = materializeReviewPresentation(rejected).current.indexOf(' after');

    expect(mapReviewCompareOffset(rejected, compareAfter)).toBe(currentAfter);
    expect(mapReviewCurrentOffset(rejected, currentAfter)).toBe(compareAfter);
    expect(mapReviewCompareOffset(rejected, change.compareRange.from)).toBe(change.compareRange.from);
  });

  it('derives change ids from content and context so they survive unrelated edits', () => {
    const base = 'Alpha one. Then the second sentence, Beta two. Gamma three.';
    const first = createReviewDraft(base, 'Alpha one. Then the second sentence, Beta 2. Gamma three.', 'base');
    const shifted = createReviewDraft(base, 'Alpha 1. Then the second sentence, Beta 2. Gamma three.', 'base');
    expect(shifted.changes).toHaveLength(2);
    const beta = (draft: typeof first) => draft.changes.find((change) => change.compareText === '2')!.id;
    expect(beta(shifted)).toBe(beta(first));
    const repeated = createReviewDraft('a x a x a', 'a y a y a', 'base');
    expect(new Set(repeated.changes.map((change) => change.id)).size).toBe(repeated.changes.length);
    expect(createReviewDraft('a x a x a', 'a y a y a', 'base').changes.map((change) => change.id)).toEqual(repeated.changes.map((change) => change.id));
  });

  it('returns an explicit too-large draft when the diff budget is exceeded', () => {
    const base = Array.from({ length: 400 }, (_, index) => `w${index}`).join(' ');
    const compare = Array.from({ length: 400 }, (_, index) => `v${index}`).join(' ');
    const draft = createReviewDraft(base, compare, 'base', new Map(), { maxEditLength: 10 });
    expect(draft).toMatchObject({ tooLarge: true, changes: [] });
    expect(() => materializeReview(draft)).toThrow(/too large/);
    expect(materializeReviewPresentation(draft).current).toBe(compare);
    expect(createReviewDraft('a b', 'a c', 'base', new Map(), { timeout: 10_000 }).tooLarge).toBeUndefined();
  });
});
