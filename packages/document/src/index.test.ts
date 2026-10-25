import { describe, expect, it } from 'vitest';
import { workspacePath } from '@markroot/core';
import { documentBlockAt, DocumentSession, mapDocumentBlocks, searchDocument, splitLines } from './index.js';

describe('DocumentSession', () => {
  it('maps mixed Markdown and guards revisions', () => {
    const source = '---\ntitle: Demo\n---\n\n# Heading\n\nText with **bold**.\n\n```{python}\n1 + 1\n```\n';
    expect(mapDocumentBlocks(source).map((block) => block.kind)).toEqual(['frontmatter', 'heading', 'paragraph', 'code']);
    const session = new DocumentSession(workspacePath('demo.qmd'), source);
    const first = session.snapshot();
    session.apply({ from: source.indexOf('Text'), to: source.indexOf('Text') + 4, insert: 'Prose', origin: 'visual', baseRevision: first.revision });
    expect(session.snapshot().source).toContain('Prose with');
    expect(searchDocument(session.snapshot(), 'prose')).toHaveLength(1);
    expect(() => session.apply({ from: 0, to: 0, insert: 'x', origin: 'source', baseRevision: 0 })).toThrow(/stale/i);
  });

  it('selects the following block at a source boundary or blank-line gap', () => {
    const blocks = mapDocumentBlocks('# First\n# Second\n\nThird\n');
    const second = blocks[1]!;
    const third = blocks[2]!;
    expect(documentBlockAt(blocks, second.from)?.id).toBe(second.id);
    expect(documentBlockAt(blocks, second.to + 1)?.id).toBe(third.id);
  });

  it('records an older saved revision without throwing when edits arrived during the save', () => {
    const session = new DocumentSession(workspacePath('demo.md'), 'a');
    session.apply({ from: 1, to: 1, insert: 'b', origin: 'source', baseRevision: 0 });
    const saving = session.snapshot().revision;
    session.apply({ from: 2, to: 2, insert: 'c', origin: 'source', baseRevision: saving });
    const seen: boolean[] = [];
    session.subscribe((snapshot) => seen.push(snapshot.dirty));
    expect(session.markSaved(saving)).toMatchObject({ savedRevision: saving, dirty: true });
    expect(seen.at(-1)).toBe(true);
    expect(session.markSaved()).toMatchObject({ dirty: false });
    expect(() => session.markSaved(99)).toThrow(/unknown revision/);
  });

  it('splits only on CRLF, CR and LF and keeps every character', () => {
    const source = 'one\rtwo\u2028still two\r\nthree\u2029\n\nfour';
    expect(splitLines(source)).toEqual(['one\r', 'two\u2028still two\r\n', 'three\u2029\n', '\n', 'four']);
    const blocks = mapDocumentBlocks(source);
    expect(blocks.map((block) => block.text).join('')).toBe('one\rtwo\u2028still two\r\nthree\u2029\nfour');
    for (const block of blocks) expect(source.slice(block.from, block.to)).toBe(block.text);
  });

  it('only treats a leading --- as front matter when a closing fence exists', () => {
    expect(mapDocumentBlocks('---\ntitle: Draft\n\n# Heading\n').map((block) => block.kind)).toEqual(['paragraph', 'heading']);
    expect(mapDocumentBlocks('---\n\ntitle: x\n---\n').map((block) => block.kind)).not.toContain('frontmatter');
    expect(mapDocumentBlocks('---\ntitle: x\n...\nBody\n').map((block) => block.kind)).toEqual(['frontmatter', 'paragraph']);
  });

  it('tracks nested divs and closes code only on a bare, long-enough fence', () => {
    const div = '::: {.callout-note}\nOuter\n\n::: {.inner}\nInner\n:::\n\n```\n:::\n```\nStill outer\n:::\n';
    expect(mapDocumentBlocks(`${div}\nAfter\n`).map((block) => block.kind)).toEqual(['div', 'paragraph']);
    expect(mapDocumentBlocks(`${div}\nAfter\n`)[0]!.text).toBe(div);
    const code = '````md\n```python\nx = 1\n```\n````\n';
    expect(mapDocumentBlocks(`${code}\nAfter\n`).map((block) => block.text)).toEqual([code, 'After\n']);
    expect(mapDocumentBlocks('~~~\n```\n~~~~\nText\n').map((block) => block.kind)).toEqual(['code', 'paragraph']);
  });
});
