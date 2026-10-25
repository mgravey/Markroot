import { describe, expect, it } from 'vitest';
import { attributeChanges, attributionProbe } from './review-attribution.js';

const alice = { actorId: 'a', displayName: 'Alice', email: 'a@x' };
const bob = { actorId: 'b', displayName: 'Bob', email: 'b@x' };

describe('review attribution', () => {
  it('attributes a change to the last commit that introduced its line', () => {
    const base = 'one\ntwo\n';
    const compare = 'one\ntwo changed\n';
    const from = compare.indexOf('changed');
    const result = attributeChanges(
      { base, compare, changes: [{ id: 'c1', baseText: '', compareText: ' changed', baseRange: { from, to: from }, compareRange: { from, to: from + 8 } }] },
      [{ author: alice, content: base }, { author: bob, content: compare }],
    );
    expect(result.get('c1')).toEqual([bob]);
  });

  it('probes around the offset of very long lines', () => {
    const line = `${'a'.repeat(300)}X${'b'.repeat(300)}`;
    const probe = attributionProbe(line, 300, 'X');
    expect(probe).toHaveLength(240);
    expect(probe).toContain('X');
  });
});
