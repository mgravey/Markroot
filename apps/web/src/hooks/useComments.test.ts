import { describe, expect, it } from 'vitest';
import { workspacePath } from '@markroot/core';
import { brokenCommentsNotice } from './useComments.js';

describe('brokenCommentsNotice', () => {
  const path = workspacePath('a.md');
  it('lists unreadable threads of the open document or of unknown documents', () => {
    const notice = brokenCommentsNotice([{ id: 't1', document: path, error: 'bad YAML' }, { id: 't2', error: 'merge conflict' }, { id: 't3', document: workspacePath('b.md'), error: 'x' }], path);
    expect(notice).toMatch(/^2 comment thread\(s\)/);
    expect(notice).toContain('t1 (bad YAML); t2 (merge conflict)');
    expect(notice).not.toContain('t3');
  });
  it('returns undefined when nothing relevant is broken', () => {
    expect(brokenCommentsNotice([{ id: 't3', document: workspacePath('b.md'), error: 'x' }], path)).toBeUndefined();
  });
});
