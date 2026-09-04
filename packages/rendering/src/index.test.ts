import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { workspacePath } from '@markroot/core';
import { DocumentSession } from '@markroot/document';
import { BasicDocumentEngine } from './index.js';

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
      citations: [{ key: 'doe2026', author: 'Doe, Jane and Roe, Richard', year: '2026', title: 'A Local-First Scholarly Workflow' }],
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
});
