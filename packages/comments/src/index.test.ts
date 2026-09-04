import { describe, expect, it, vi } from 'vitest';
import { createThread, deleteThread, parseComments, replyToThread, setThreadStatus, stripCommentMarkup } from './index.js';

describe('embedded comments', () => {
  it('round-trips threads without changing rendered source', () => {
    vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000001' });
    const source = '# Title\n\nComment this prose.\n';
    const from = source.indexOf('this');
    const author = { actorId: 'local', displayName: 'Ada' };
    const created = createThread(source, { from, to: from + 4 }, 'Check wording', author, { now: '2026-01-01T00:00:00.000Z' });
    expect(parseComments(created.source).threads).toHaveLength(1);
    expect(stripCommentMarkup(created.source)).toBe(source);
    const replied = replyToThread(created.source, created.thread.id, 'Agreed', author);
    expect(parseComments(replied).threads[0]?.messages).toHaveLength(2);
    const resolved = setThreadStatus(replied, created.thread.id, 'resolved');
    expect(parseComments(resolved).threads[0]?.status).toBe('resolved');
    expect(deleteThread(resolved, created.thread.id)).toBe(source);
  });
});
