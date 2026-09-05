import { describe, expect, it } from 'vitest';
import { workspacePath } from '@markroot/core';
import { documentBlockAt, DocumentSession, mapDocumentBlocks, searchDocument } from './index.js';

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
});
