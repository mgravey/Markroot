import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { workspacePath } from '@markroot/core';
import { DocumentSession } from '@markroot/document';
import { BasicDocumentEngine, maskMarkdownHtmlComments } from './index.js';

describe('BasicDocumentEngine', () => {
  it('renders mapped blocks and warns without executing QMD code', async () => {
    const snapshot = new DocumentSession(workspacePath('paper.qmd'), '# Paper\n\n```{python}\nprint(1)\n```\n').snapshot();
    const result = await new BasicDocumentEngine().render({ snapshot });
    expect(result.html).toContain('data-block-id');
    expect(result.html).toContain('print(1)');
    expect(result.warnings[0]).toMatch(/never executed/i);
  });

  it('keeps source mappings across the QMD compatibility fixture', async () => {
    const source = await readFile(new URL('../../../fixtures/compatibility/kitchen-sink.qmd', import.meta.url), 'utf8');
    const snapshot = new DocumentSession(workspacePath('kitchen-sink.qmd'), source).snapshot();
    const result = await new BasicDocumentEngine().render({
      snapshot,
      dependencies: [{ path: 'figure.svg', content: new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type: 'image/svg+xml' }) }],
      citations: [{ key: 'doe2026', author: 'Doe, Jane and Roe, Richard', year: '2026', title: 'A Local-First Scholarly Workflow', doi: '10.1234/markroot.2026' }],
    });
    expect(result.anchors.length).toBe(snapshot.blocks.length);
    expect(new Set(result.anchors.map((anchor) => anchor.id)).size).toBe(result.anchors.length);
    expect(result.html).toContain('callout-note');
    expect(result.html).toContain('<math');
    expect(result.html).toContain('class="math-display"');
    expect(result.html).toContain('<figure id="fig-example"');
    expect(result.html).toContain('data-figure-width="60%"');
    expect(result.html).toContain('Figure 1.');
    expect(result.html).toContain('A local test figure with a citation');
    expect(result.html).toContain('figure-layout layout-cols-2');
    expect(result.html).toContain('data-source-offset');
    expect(result.html).toContain('blob:');
    expect(result.html).toContain('Doe &amp; Roe, 2026');
    expect(result.html).toContain('data-doi-url="https://doi.org/10.1234/markroot.2026"');
    expect(result.html).toContain('class="doi-link"');
    expect(result.html).toContain('aria-label="References"');
    expect(result.html).toContain('class="crossref"');
    expect(result.warnings).toContain('Code cells are shown as source and are never executed in Markroot.');
    result.objectUrls?.forEach((url) => URL.revokeObjectURL(url));
  });

  it('renders a local image whose relative path contains spaces', async () => {
    const snapshot = new DocumentSession(workspacePath('chapters/paper.md'), '![Mapped figure](<../figures/my plot.png>){#fig-map width="72%" fig-align="right" fig-cap-location="top" fig-alt="Accessible plot"}\n').snapshot();
    const result = await new BasicDocumentEngine().render({
      snapshot,
      dependencies: [{ path: '../figures/my plot.png', content: new Blob(['image'], { type: 'image/png' }) }],
    });
    expect(result.html).toContain('<figure id="fig-map"');
    expect(result.html).toContain('class="figure-align-right"');
    expect(result.html).toContain('data-caption-location="top"');
    expect(result.html).toContain('data-figure-width="72%"');
    expect(result.html).toContain('alt="Accessible plot"');
    expect(result.html).toMatch(/<img src="blob:/);
    result.objectUrls?.forEach((url) => URL.revokeObjectURL(url));
  });

  it('replaces unresolved local images with a non-fetching diagnostic', async () => {
    const snapshot = new DocumentSession(workspacePath('paper.md'), '![Missing chart](figures/missing.png){#fig-missing}\n').snapshot();
    const result = await new BasicDocumentEngine().render({ snapshot });
    expect(result.warnings).toContain('Local image not found: figures/missing.png');
    expect(result.html).toContain('class="image-missing"');
    expect(result.html).not.toContain('src="figures/missing.png"');
  });

  it('numbers sections and tables while respecting unnumbered headings', async () => {
    const source = `# Abstract {.unnumbered}

# Results {#sec-results}

## Measurements

| Sample | Value |
|:-------|------:|
| A      | 2     |
: Measurements {#tbl-measurements}
`;
    const snapshot = new DocumentSession(workspacePath('paper.qmd'), source).snapshot();
    const result = await new BasicDocumentEngine().render({ snapshot });

    expect(result.html).toContain('<h1 id="abstract" class="unnumbered"');
    expect(result.html).toContain('<span class="section-number">1</span> Results');
    expect(result.html).toContain('<span class="section-number">1.1</span> Measurements');
    expect(result.html).toContain('<span class="table-label">Table 1.</span> Measurements');
    expect(result.outline?.map(({ kind, label, number }) => ({ kind, label, number }))).toEqual([
      { kind: 'section', label: 'Abstract', number: undefined },
      { kind: 'section', label: 'Results', number: '1' },
      { kind: 'section', label: 'Measurements', number: '1.1' },
      { kind: 'table', label: 'Measurements', number: '1' },
    ]);
  });

  it('allows section numbering to be disabled in front matter', async () => {
    const snapshot = new DocumentSession(workspacePath('paper.qmd'), '---\nnumber-sections: false\n---\n\n# Introduction\n').snapshot();
    const result = await new BasicDocumentEngine().render({ snapshot });
    expect(result.html).not.toContain('section-number');
    expect(result.outline?.[0]).toMatchObject({ label: 'Introduction' });
    expect(result.outline?.[0]?.number).toBeUndefined();
  });

  it('hides Markdown HTML comments without changing code literals or source length', async () => {
    const source = `# Visible title <!-- private heading note -->

Visible <!-- private prose note --> text.

<!-- private block note -->

\`<!-- inline code -->\`

~~~html
<!-- fenced code -->
~~~
`;
    const masked = maskMarkdownHtmlComments(source);
    const result = await new BasicDocumentEngine().render({ snapshot: new DocumentSession(workspacePath('comments.md'), source).snapshot() });

    expect(masked).toHaveLength(source.length);
    expect(masked.split('\n')).toHaveLength(source.split('\n').length);
    expect(result.html).toContain('Visible title');
    expect(result.html).toMatch(/Visible\s+text\./);
    expect(result.html).not.toContain('private heading note');
    expect(result.html).not.toContain('private prose note');
    expect(result.html).not.toContain('private block note');
    expect(result.html).toContain('&lt;!-- inline code --&gt;');
    expect(result.html).toContain('&lt;!-- fenced code --&gt;');
  });

  it('inserts the bibliography at an explicit refs div instead of appending a duplicate section', async () => {
    const source = `# Findings

Evidence supports the result [@doe2026].

# References {.unnumbered}

::: {#refs}
:::

# Appendix {.unnumbered}
`;
    const result = await new BasicDocumentEngine().render({
      snapshot: new DocumentSession(workspacePath('references.qmd'), source).snapshot(),
      citations: [{ key: 'doe2026', author: 'Doe, Jane', year: '2026', title: 'Placed bibliography' }],
    });

    expect(result.html).not.toContain(':::');
    expect(result.html).toContain('<div class="references references-explicit" id="refs"');
    expect(result.html).not.toContain('<h2>References</h2>');
    expect(result.html.indexOf('id="ref-doe2026"')).toBeLessThan(result.html.indexOf('id="appendix"'));
  });

  it('retains an automatic references section when no refs placeholder exists', async () => {
    const result = await new BasicDocumentEngine().render({
      snapshot: new DocumentSession(workspacePath('references.md'), 'Evidence [@doe2026].\n').snapshot(),
      citations: [{ key: 'doe2026', author: 'Doe, Jane', year: '2026', title: 'Fallback bibliography' }],
    });

    expect(result.html).toContain('<section class="references"');
    expect(result.html).toContain('<h2>References</h2>');
  });
});
