import { describe, expect, it } from 'vitest';
import { editorLineChanges } from './editor-line-changes.js';

describe('editor line changes', () => {
  it('marks inserted lines against HEAD', () => {
    expect(editorLineChanges('first\nlast\n', 'first\nnew\nlast\n')).toEqual([{ line: 2, kind: 'added' }]);
  });

  it('marks replacement lines as modified', () => {
    expect(editorLineChanges('first\nold\nlast\n', 'first\nnew\nlast\n')).toEqual([{ line: 2, kind: 'modified' }]);
  });

  it('anchors deleted lines to a remaining editor line', () => {
    expect(editorLineChanges('first\nremove\nlast\n', 'first\nlast\n')).toEqual([{ line: 2, kind: 'deleted' }]);
    expect(editorLineChanges('first\nremove', 'first')).toEqual([{ line: 1, kind: 'deleted' }]);
  });

  it('returns no markers without a Git base or a change', () => {
    expect(editorLineChanges(undefined, 'draft')).toEqual([]);
    expect(editorLineChanges('same', 'same')).toEqual([]);
  });
});
