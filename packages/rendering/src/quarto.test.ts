import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { workspacePath } from '@markroot/core';
import { DocumentSession } from '@markroot/document';
import { BasicDocumentEngine, documentResourceReferences } from './index.js';

const snapshot = (source: string) => new DocumentSession(workspacePath('paper/report.qmd'), source).snapshot();
const render = (source: string) => new BasicDocumentEngine().render({ snapshot: snapshot(source) });

describe('static Quarto preview', () => {
  it('hides setup and excluded chunks but preserves zero-height mapped blocks', async () => {
    const source = '---\nexecute: {echo: false}\n---\n```{r setup}\nx <- 1\n```\n```{r, include=FALSE}\nsecret()\n```\n';
    const doc = snapshot(source);
    const result = await new BasicDocumentEngine().render({ snapshot: doc });
    expect(result.html).not.toContain('x &lt;-');
    expect(result.html).not.toContain('secret()');
    expect(result.html).not.toContain('not available');
    for (const block of doc.blocks.filter((block) => block.kind === 'code')) {
      expect(result.html).toContain(`class="mr-block mr-code mr-hidden" data-block-id="${block.id}" data-source-from="${block.from}" data-source-to="${block.to}"`);
    }
  });

  it('merges knitr defaults, execution defaults, header args and leading comment options', async () => {
    const result = await render('---\nknitr:\n  opts_chunk: {echo: false}\nexecute: {echo: true}\n---\n```{r example, echo=F}\n#| echo: true\n#| eval: false\nvisible()\n```\n```{r suppressed, echo=FALSE, output=FALSE}\nhidden()\n```\n```{python}\n#| echo: false\n#| label: summary\nprint(2)\n```\n');
    expect(result.html).toContain('visible()');
    expect(result.html).not.toContain('#|');
    expect(result.html).not.toContain('hidden()');
    expect(result.html).not.toContain('print(2)');
    expect(result.html).toContain('Output of chunk ‘summary’ is not available');
  });

  it('supports slash comments, quoted header commas, fenced echo and eval/output suppression', async () => {
    const result = await render('```{javascript}\n//| echo: false\n//| label: report\n//| eval: false\nalert(1)\n```\n```{r, echo="fenced", label="a,b"}\nx + 1\n```\n```{r text, echo=F, results="asis", output=F}\ncat(x)\n```');
    expect(result.html).not.toContain('alert');
    expect(result.html).not.toContain('not available');
    expect(result.html).toContain('```{r, echo=');
    expect(result.html).toContain('x + 1');
  });

  it('renders inline R expressions intentionally, leaving ordinary code intact', async () => {
    const result = await render('Value `r mean(x)` or `{r} nrow(x)`, ordinary `run(x)` and `@fig-x` code.');
    expect(result.html.match(/class="inline-expression"/g)).toHaveLength(2);
    expect(result.html).toContain('title="Inline R expression — not executed"');
    expect(result.html).toContain('<code>run(x)</code>');
    expect(result.html).toContain('<code>@fig-x</code>');
  });

  it('renders a synthetic manuscript with figures, equations, declarations and explicit references', async () => {
    const source = await readFile(new URL('../../../fixtures/compatibility/static-chunks.qmd', import.meta.url), 'utf8');
    const doc = snapshot(source);
    const paths = ['figures/calibration_trace.png', 'figures/comparison.pdf'];
    expect(documentResourceReferences(doc, paths)).toEqual([
      { reference: '../figures/calibration_trace.png', path: 'figures/calibration_trace.png' },
      { reference: '../figures/comparison.pdf', path: 'figures/comparison.pdf' },
    ]);
    const result = await new BasicDocumentEngine().render({ snapshot: doc, workspacePaths: paths, dependencies: paths.map((path) => ({ path: `../${path}`, content: 'image', objectUrl: `blob:${path}` })) });
    expect(result.html).not.toContain('metadata-files');
    expect(result.html).not.toContain('caption_text &lt;-');
    expect(result.html).toContain('Output of chunk ‘summary’ is not available');
    expect(result.html).toContain('src="blob:figures/calibration_trace.png"');
    expect(result.html).toContain('src="blob:figures/comparison.pdf"');
    expect(result.html).toContain('data-figure-width="75%"');
    expect(result.html).toContain('href="#fig-first" data-source-offset=');
    expect(result.html).toContain('>Figure 1</a>');
    expect(result.html).toContain('<span class="figure-label">Figure 1.</span> A <strong>calibration</strong>');
    expect(result.html).toContain('>Figure 2</a>');
    expect(result.html).toContain('Range … units; coverage …%.');
    expect(result.html).toContain('Figure produced by code (not executed)');
    expect(result.html).toContain('id="eq-linear"');
    expect(result.html).toContain('>Equation 1</a>');
    expect(result.html).toContain('<strong>Data policy.</strong> All observations');
    expect(result.html).toContain('<li><strong>Prepare.</strong>');
    expect(result.html).toContain('<span class="section-number">1</span> Background');
  });

  it('decodes unstructured legacy citation names and titles everywhere', async () => {
    const result = await new BasicDocumentEngine().render({ snapshot: snapshot('[@legacy]\n\n::: {#refs}\n:::\n\nAfter.'), citations: [{ key: 'legacy', author: String.raw`P{\'e}ron, Guillaume and Calabrese, Justin M.`, title: String.raw`A {\'e}tude`, year: '2020' }] });
    expect(result.html).toContain('Péron &amp; Calabrese, 2020');
    expect(result.html).toContain('Péron, Guillaume and Calabrese, Justin M.');
    expect(result.html).toContain('title="A étude"');
    expect(result.html).not.toContain("\\'");
    expect(result.html.indexOf('id="refs"')).toBeLessThan(result.html.indexOf('After.'));
  });
});

it('resolves captions from multiline R strings, sprintf templates and quoted expressions', async () => {
  const source = String.raw`---
execute: {echo: false}
---
` + '```{r setup}\n' + String.raw`multiline <- "A **literal**\ncaption with \"quotes\" and \u00e9."
single = 'Another
line.'
formatted <- sprintf("Value %1$.2f / %02d / %% / %s.", x, y, z)
` + '\n```\n' + ['!expr multiline', '!expr single', '!expr formatted', '!expr "A **quoted** caption."', '!expr unknown'].map((caption, index) => `\n\x60\x60\x60{r}\n#| label: fig-${index}\n#| fig-cap: ${caption}\nplot(x)\n\x60\x60\x60\n`).join('');
  const result = await new BasicDocumentEngine().render({ snapshot: snapshot(source) });
  expect(result.html).toContain('A <strong>literal</strong>');
  expect(result.html).toContain('caption with “quotes” and é.');
  expect(result.html).toContain('Another\nline.');
  expect(result.html).toContain('Value … / … / % / ….');
  expect(result.html).toContain('A <strong>quoted</strong> caption.');
  expect(result.html.match(/Caption computed by code/g)).toHaveLength(1);
});

it('uses document/root/project path precedence, extensions, folder preference and nearest unique stems', () => {
  const doc = snapshot('---\nknitr:\n  opts_knit: {root.dir: "../analysis"}\n---\n```{r fig-test}\nfig("trace")\n```');
  const refs = (paths: string[]) => documentResourceReferences(doc, paths).map((ref) => ref.path);
  expect(refs(['trace.png', 'analysis/trace.png', 'paper/trace.pdf'])).toEqual(['paper/trace.pdf']);
  expect(refs(['trace.png', 'analysis/trace.pdf'])).toEqual(['analysis/trace.pdf']);
  expect(refs(['trace.pdf', 'trace.svg', 'trace.png'])).toEqual(['trace.png']);
  expect(refs(['assets/trace.png', 'archive/figures/trace.pdf'])).toEqual(['archive/figures/trace.pdf']);
  expect(refs(['paper/figures/trace.png', 'archive/deep/figures/trace.png'])).toEqual(['paper/figures/trace.png']);
  expect(refs(['a/figures/trace.png', 'b/figures/trace.png'])).toEqual([]);
  expect(refs(['figures/trace.pdf', 'figures/trace.png'])).toEqual(['figures/trace.png']);
});

it('collects file.path literals and ignores comment strings, excluded code and front matter images', () => {
  const doc = snapshot('---\ntitle: "![fake](absent.png)"\n---\n```{r fig-first}\nknitr::include_graphics(file.path("figures", "real.png"))\n# file.path("figures", "decoy.png")\n```\n```{r fig-hidden, include=F}\nfig("hidden")\n```\n```r\n![fake](fake.png)\n```\n\n![Normal](../figures/normal.png)');
  expect(documentResourceReferences(doc, ['figures/real.png', 'figures/decoy.png', 'figures/hidden.png'])).toEqual([
    { reference: '../figures/real.png', path: 'figures/real.png' },
    { reference: '../figures/normal.png', path: 'figures/normal.png' },
  ]);
});

it('invalidates cached chunk output for changed defaults, captions, paths and resource availability', async () => {
  const engine = new BasicDocumentEngine();
  const citations: never[] = [];
  const source = (caption: string, echo: boolean) => `---\nexecute: {echo: ${echo}}\n---\n\x60\x60\x60{r setup, include=F}\ncap <- "${caption}"\n\x60\x60\x60\n\x60\x60\x60{r fig-a, fig.cap=cap}\n#| fig-cap: !expr cap\nfig("trace")\n\x60\x60\x60`;
  const first = await engine.render({ snapshot: snapshot(source('First', false)), citations, workspacePaths: ['figures/trace.png'], dependencies: [{ path: '../figures/trace.png', content: '', objectUrl: 'blob:first' }] });
  expect(first.html).toContain('src="blob:first"');
  const request = { snapshot: snapshot(source('Second', true)), citations, workspacePaths: ['figures/trace.pdf'], dependencies: [{ path: '../figures/trace.pdf', content: '', objectUrl: 'blob:second' }] };
  const second = await engine.render(request);
  expect(second.html).toContain('src="blob:second"');
  expect(second.html).toContain('Second');
  expect(second.html).toContain('fig(&quot;trace&quot;)');
  expect(second.html).toBe((await new BasicDocumentEngine().render(request)).html);
  expect((await engine.render({ ...request, dependencies: [] })).html).toContain('class="image-missing"');
  expect((await engine.render({ ...request, workspacePaths: [] })).html).toContain('Figure produced by code (not executed)');
});

it.each(['include: false', 'eval: false', 'output: false'])('respects document %s for hidden chunks and figure resources', async (option) => {
  const doc = snapshot(`---\nexecute: {echo: false, ${option}}\n---\n\x60\x60\x60{r fig-x}\nfig("trace")\n\x60\x60\x60\n\x60\x60\x60{r summary, results="asis"}\ncat(x)\n\x60\x60\x60`);
  expect(documentResourceReferences(doc, ['figures/trace.png'])).toEqual([]);
  const result = await new BasicDocumentEngine().render({ snapshot: doc, workspacePaths: ['figures/trace.png'] });
  expect(result.html).not.toContain('<figure');
  expect(result.html).not.toContain('not available');
});

it('keeps normal images and fenced div images in the same figure numbering stream as chunks', async () => {
  const result = await render('---\nexecute: {echo: false}\n---\n![First](a.png){#fig-first}\n\n::: {.example}\n![Second](b.png){#fig-second}\n:::\n\n```{r fig-third, fig.cap="Third"}\nplot(x)\n```\n\n@fig-first @fig-second @fig-third');
  expect(result.html).toContain('>Figure 1</a>');
  expect(result.html).toContain('>Figure 2</a>');
  expect(result.html).toContain('>Figure 3</a>');
});

it('anchors computed caption content to its owning figure chunk rather than synthetic text offsets', async () => {
  const doc = snapshot('---\nexecute: {echo: false}\n---\n```{r setup, include=F}\ncap <- "A long synthetic caption with words before $x$ and a reference to @fig-x."\n```\n```{r fig-x, fig.cap=cap}\nplot(x)\n```');
  const result = await new BasicDocumentEngine().render({ snapshot: doc });
  const figure = doc.blocks.at(-1)!;
  const offsets = [...result.html.matchAll(/data-source-offset="(\d+)"/g)].map((match) => Number(match[1]));
  expect(offsets.length).toBeGreaterThan(2);
  expect(offsets.every((offset) => offset >= figure.from && offset < figure.to)).toBe(true);
});

it('numbers a fenced div figure once and renders its final paragraph as the caption', async () => {
  const result = await render('::: {#fig-group}\n![Accessible image](a.png)\n\nA **grouped** caption.\n:::\n\n```{r fig-chunk, echo=F}\nplot(x)\n```\n\nSee @fig-group and @fig-chunk.');
  expect(result.html).toContain('<figure id="fig-group"');
  expect(result.html).toContain('<span class="figure-label">Figure 1.</span> A <strong>grouped</strong> caption.');
  expect(result.html).toContain('>Figure 1</a>');
  expect(result.html).toContain('>Figure 2</a>');
  expect(result.outline?.filter((item) => item.kind === 'figure')).toHaveLength(2);
});
