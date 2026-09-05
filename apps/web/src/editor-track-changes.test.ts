import { describe, expect, it } from 'vitest';
import { editorTrackChanges } from './editor-track-changes.js';

describe('editor track changes', () => {
  it('places inserted and deleted words in the current document', () => {
    expect(editorTrackChanges('A small draft.', 'A concise draft.')).toEqual([
      { kind: 'delete', at: 2, value: 'small' },
      { kind: 'insert', from: 2, to: 9 },
    ]);
  });

  it('tracks additions without inventing deleted content', () => {
    expect(editorTrackChanges('One sentence.', 'One clear sentence.')).toEqual([
      { kind: 'insert', from: 4, to: 10 },
    ]);
  });

  it('returns no annotations without a Git base or a change', () => {
    expect(editorTrackChanges(undefined, 'Draft')).toEqual([]);
    expect(editorTrackChanges('Same', 'Same')).toEqual([]);
  });
});
