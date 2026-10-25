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
    expect(result.warnings).toContain('Code cells are never executed in Markroot; computed output may be unavailable.');
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

  const render = (source: string, options: { citations?: readonly { key: string; title?: string; author?: string; year?: string; authors?: readonly ({ family: string } | { literal: string })[] }[]; allowRemoteResources?: boolean; engine?: BasicDocumentEngine } = {}) =>
    (options.engine ?? new BasicDocumentEngine()).render({ snapshot: new DocumentSession(workspacePath('paper.qmd'), source).snapshot(), ...(options.citations ? { citations: options.citations } : {}), ...(options.allowRemoteResources !== undefined ? { allowRemoteResources: options.allowRemoteResources } : {}) });
  const doe = { key: 'doe', author: 'Doe, Jane', year: '2026', title: 'Doe paper' };

  it('keeps bare CR and U+2028/U+2029 segments when masking comments', () => {
    const source = 'a\rb <!-- x -->\u2028c\u2029d';
    expect(maskMarkdownHtmlComments(source)).toBe(`a\rb ${' '.repeat(10)}\u2028c\u2029d`);
  });

  it('inserts replacement text containing $ patterns literally', async () => {
    const citations = [{ ...doe, title: "Costs $& and $' and $$ and $`" }];
    const result = await render('See [@doe] and @doe.\n\n::: {#refs}\n:::\n', { citations });
    expect(result.html).toContain("Costs $&amp; and $' and $$ and $`");
    expect(result.html).toContain(`title="Costs $&amp; and $' and $$ and $\`"`);
  });

  it('never substitutes math, citations or cross-references inside code or link destinations', async () => {
    const result = await render([
      '```', '$x$ [@doe] @fig-a $$y$$', '```', '',
      'Inline `$x$ @doe` code and [a link](https://x.org/$y$z$) here.', '',
      '[r]: missing.png', '![see $x$][r]', '',
      '::: {.callout-note}', '```', '$z$', '```', ':::', '',
    ].join('\n'), { citations: [doe] });
    expect(result.html).not.toContain('math-inline');
    expect(result.html).not.toContain('class="citation');
    expect(result.html).toContain('$x$ [@doe] @fig-a $$y$$');
    expect(result.html).toContain('<code>$x$ @doe</code>');
    expect(result.html).toContain('href="https://x.org/$y$z$"');
    expect(result.html).toContain('$z$');
    expect(result.html).not.toMatch(/\ue000|MRROOT/);
  });

  it('restores placeholders as source text inside attribute values', async () => {
    const result = await render('[r]: https://example.org/a.png\n![see $x$][r]\n', { allowRemoteResources: true });
    expect(result.html).toContain('alt="see $x$"');
    expect(result.html).not.toMatch(/alt="[^"]*</);
  });

  it('follows Pandoc dollar rules for inline math', async () => {
    const prices = await render('It costs $5 and $10 today, or $ 3 $ maybe.\n');
    expect(prices.html).not.toContain('math-inline');
    const math = await render('Inline $x^2$ and $a+b$, done.\n');
    expect(math.html.match(/math-inline/g)).toHaveLength(2);
  });

  it('does not read e-mail addresses in links or prose as citations', async () => {
    const result = await render('Write [contact@example.org](mailto:contact@example.org), or a@doe.org, or [x@doe]. Cite [@doe].\n', { citations: [doe] });
    expect(result.html).toContain('<a href="mailto:contact@example.org">contact@example.org</a>');
    expect(result.html.match(/class="citation"/g)).toHaveLength(1);
  });

  it('numbers cross-references exactly as the renderer numbers headings, figures, equations and tables', async () => {
    const result = await render([
      '---', 'title: Demo', '# not a heading', '---', '',
      'See @sec-intro, @fig-b, @eq-one, @tbl-t and @fig-missing.', '',
      '```', '# code comment', '$$ x $$', '![Code](c.png){#fig-code}', '```', '',
      '![](a.png)', '',
      '# Intro {#sec-intro}', '',
      '![Caption](b.png){#fig-b}', '',
      '$$ y $$ {#eq-one}', '',
      '| A | B |', '|---|---|', '| 1 | 2 |', ': Values {#tbl-t}', '',
    ].join('\n'));
    const labels = [...result.html.matchAll(/<a class="crossref" href="#([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((match) => [match[1], match[2]]);
    expect(labels).toEqual([['sec-intro', 'Section 1'], ['fig-b', 'Figure 1'], ['eq-one', 'Equation 1'], ['tbl-t', 'Table 1']]);
    expect(result.html).toContain('@fig-missing');
    expect(result.html).toContain('<span class="figure-label">Figure 1.</span> Caption');
  });

  it('renders an unterminated --- opener as document content', async () => {
    const result = await render('---\ntitle: Draft\n\n# Heading\n');
    expect(result.html).toContain('Heading</h1>');
  });

  it('renders nested divs and code inside callouts', async () => {
    const result = await render('::: {.callout-note}\nOuter\n\n::: {.inner #box}\nInner $x$\n:::\n\n```\n:::\n```\n:::\n\nAfter\n');
    expect(result.html).toContain('<aside class="callout callout-note">');
    expect(result.html).toMatch(/<div id="box" class="inner"><p>Inner <span class="math-inline"/);
    expect(result.html).toContain('<pre><code>:::\n</code></pre>');
    expect(result.html).not.toMatch(/<p>:::/);
  });

  it('keeps Unicode headings, ids and cross-reference keys', async () => {
    const result = await render('# Введение\n\n# 引言 {#sec-引言}\n\n![Café](c.png){#fig-café}\n\nSee @sec-引言 and @fig-café.\n');
    expect(result.html).toContain('<h1 id="введение"');
    expect(result.html).toContain('<h1 id="sec-引言"');
    expect(result.html).toContain('<figure id="fig-café"');
    expect(result.html).toContain('href="#sec-引言"');
    expect(result.html).toContain('href="#fig-café"');
  });

  it('emits legacy ASCII and fallback heading anchors alongside Unicode primary ids', async () => {
    const result = await render('# α Biology\n\n## 引言\n\nSee [old](#biology), [new](#α-biology) and [fallback](#mr-section-2).\n');
    expect(result.html).toContain('<h1 id="α-biology"');
    expect(result.html).toMatch(/<span id="biology"[^>]*data-source-offset="0"[^>]*><\/span>/);
    expect(result.html).toContain('<h2 id="引言"');
    expect(result.html).toContain('<span id="mr-section-2"');
    expect(result.html).toContain('href="#biology"');
    expect(result.html).toContain('href="#%CE%B1-biology"');
  });

  it('allocates aliases without duplicating primary ids and replays cached aliases correctly', async () => {
    const engine = new BasicDocumentEngine();
    const source = '# α Biology\n\n# Biology\n\n# α Biology\n\n# 日本語\n';
    const result = await render(source, { engine });
    expect(result.html).toContain('<h1 id="biology"');
    expect(result.html).toContain('<span id="biology-2"');
    expect(result.html).toContain('<span id="biology-3"');
    expect(result.html).toContain('<span id="mr-section-4"');
    const ids = [...result.html.matchAll(/\bid="([^"]*)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    const revised = '![Figure](missing.png){#fig-one}\n\n' + source;
    expect((await render(revised, { engine })).html).toBe((await render(revised)).html);
    expect((await render(revised, { engine })).html).toContain('<span id="mr-section-5"');
  });

  it('resolves cross-references through both generated Unicode and legacy heading ids', async () => {
    const result = await render('# Sec α Biology\n\nSee @sec-α-biology and @sec-biology.\n');
    expect(result.html).toMatch(/href="#sec-α-biology"[^>]*>Section 1<\/a>/);
    expect(result.html).toMatch(/href="#sec-biology"[^>]*>Section 1<\/a>/);
    expect(result.html).toContain('<span id="sec-biology"');
  });

  it('does not add aliases when duplicate ASCII heading ids already match the legacy ids', async () => {
    const result = await render('# Biology\n\n# Biology\n');
    expect(result.html).toContain('<h1 id="biology"');
    expect(result.html).toContain('<h1 id="biology-2"');
    expect(result.html).not.toMatch(/<span id=/);
  });

  it('reserves bibliography ids before allocating heading aliases', async () => {
    const result = await render('# α Ref Doe\n\n[@doe]\n', { citations: [doe] });
    expect(result.html).toContain('<span id="ref-doe-2"');
    expect(result.html.match(/ id="ref-doe"/g)).toHaveLength(1);
  });

  it('keeps brace-protected corporate authors whole in citation labels', async () => {
    const result = await render('[@who]\n', { citations: [{ key: 'who', author: 'World Health Organization', authors: [{ literal: 'World Health Organization' }], year: '2020' }] });
    expect(result.html).toContain('World Health Organization, 2020');
  });

  it('blocks remote images unless remote resources are allowed', async () => {
    const source = '![Logo](https://example.org/logo.png){#fig-logo}\n';
    const blocked = await render(source);
    expect(blocked.html).not.toContain('src="https://example.org/logo.png"');
    expect(blocked.html).toContain('class="remote-resource-placeholder"');
    expect(blocked.html).toContain('Remote image blocked: Logo');
    const allowed = await render(source, { allowRemoteResources: true });
    expect(allowed.html).toContain('src="https://example.org/logo.png"');
  });

  it('reuses cached blocks without stale offsets, numbering or identifiers', async () => {
    const engine = new BasicDocumentEngine();
    const first = await render('# Intro\n\nText\n\n# Intro\n\n![Cap](a.png){#fig-a}\n', { engine });
    expect(first.html).toContain('<h1 id="intro-2"');
    const second = await render('# Start\n\nLonger text here\n\n# Intro\n\n![Cap](a.png){#fig-a}\n', { engine });
    const fresh = await render('# Start\n\nLonger text here\n\n# Intro\n\n![Cap](a.png){#fig-a}\n');
    expect(second.html).toBe(fresh.html);
    expect(second.outline).toEqual(fresh.outline);
    expect(second.html).toContain('<h1 id="intro"');
    const source = '# Start\n\nLonger text here\n\n# Intro\n\n![Cap](a.png){#fig-a}\n';
    expect(second.html).toContain(`data-source-offset="${source.indexOf('![Cap]')}"`);
    const third = await render('# Start\n\n![New](n.png){#fig-n}\n\n# Intro\n\n![Cap](a.png){#fig-a}\n', { engine });
    expect(third.html).toContain('<span class="figure-label">Figure 2.</span> Cap');
  });

  it('stops rendering when the operation is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(new BasicDocumentEngine().render({ snapshot: new DocumentSession(workspacePath('a.md'), '# A\n').snapshot() }, { signal: controller.signal })).rejects.toThrow(/cancelled/i);
  });
});
