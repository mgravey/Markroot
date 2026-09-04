import { describe, expect, it } from 'vitest';
import { createReviewDraft, decideChange, materializeReview } from './index.js';

describe('review draft', () => {
  it('applies explicit accept and reject decisions', () => {
    const draft = createReviewDraft('A small draft.', 'A concise draft!', 'base');
    const decided = draft.changes.reduce((current, change, index) => decideChange(current, change.id, index === 0 ? 'accept' : 'reject'), draft);
    expect(() => materializeReview(draft)).toThrow(/decision/);
    expect(materializeReview(decided)).toContain('concise');
  });
});
