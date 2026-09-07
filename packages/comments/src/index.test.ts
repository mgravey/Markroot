import { describe, expect, it } from 'vitest';
import { commentRevision, createSelector, locateComments, locateSelector, parseComments, stripCommentMarkup, type CommentThread } from './index.js';

const source = '# Title\n\nComment this prose.\n';
const from = source.indexOf('this');
const selector = createSelector(source, { from, to: from + 4 });
const thread: CommentThread = { id: 'abc-123', selector, status: 'open', createdAt: '2026-01-01', updatedAt: '2026-01-01', messages: [{ id: 'msg-1', author: { actorId: 'ada', displayName: 'Ada' }, body: 'Check wording', createdAt: '2026-01-01' }] };

describe('sidecar anchors', () => {
  it('follows an unchanged passage across insertions without changing metadata', () => {
    const changed = `An introduction.\n\n${source}`;
    const original = JSON.stringify(thread);
    expect(locateComments(changed, [thread]).ranges.get(thread.id)?.from).toBe(changed.indexOf('this'));
    expect(JSON.stringify(thread)).toBe(original);
  });

  it('detaches edited, deleted and ambiguous passages instead of trusting stale offsets', () => {
    expect(locateComments(source.replace('this', 'that'), [thread]).orphans).toEqual([thread.id]);
    expect(locateSelector('this and this', { ...selector, prefix: '', suffix: '' })).toBeUndefined();
    expect(locateSelector('prefix this suffix; this other', { ...selector, prefix: 'prefix ', suffix: ' suffix' })).toEqual({ from: 7, to: 11 });
  });

  it('flags a merged resolution when the reviewed context changes', async () => {
    const revision = await commentRevision(source, 'a'.repeat(40));
    const resolved: CommentThread = { ...thread, status: 'resolved', resolution: { revision, selector, at: '2026-01-02', author: thread.messages[0]!.author } };
    expect(locateComments(source, [resolved]).needsReview).toEqual([]);
    expect(locateComments(source.replace('prose', 'claim'), [resolved]).needsReview).toEqual([thread.id]);
    expect((await commentRevision(source + 'changed', revision.commit)).contentHash).not.toBe(revision.contentHash);
  });
});

describe('legacy migration reader', () => {
  it('extracts threads and clean ranges without keeping inline markers', () => {
    const marked = `${source.slice(0, from)}<!-- markroot:anchor:v1 id=abc-123 edge=start -->this<!-- markroot:anchor:v1 id=abc-123 edge=end -->${source.slice(from + 4)}`;
    const embedded = `${marked}\n<!-- markroot:threads:v1\n${JSON.stringify({ version: 1, threads: [thread] })}\n-->\n`;
    const parsed = parseComments(embedded);
    expect(parsed.cleanSource).toBe(source);
    expect(parsed.ranges.get(thread.id)).toEqual({ from, to: from + 4 });
    expect(parsed.threads[0]?.messages).toEqual(thread.messages);
    expect(stripCommentMarkup(embedded)).toBe(source);
  });

  it('preserves ordinary Markdown byte-for-byte and refuses malformed legacy data', () => {
    const plain = 'text  \n\n<!-- ordinary comment -->\n\n';
    expect(parseComments(plain).cleanSource).toBe(plain);
    expect(() => parseComments('text\n<!-- markroot:threads:v1\n{broken}\n-->\n')).toThrow();
  });
});
