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
});
