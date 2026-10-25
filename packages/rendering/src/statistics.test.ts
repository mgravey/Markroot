import { describe, expect, it, vi } from 'vitest';
import { DocumentSession } from '@markroot/document';
import { workspacePath } from '@markroot/core';
import { BasicDocumentEngine, DocumentStatisticsCalculator, countWords, documentStatistics } from './index.js';

const citation = { key: 'peron2020', authors: [{ family: 'Péron' }, { family: 'Chen' }, { family: 'Silva' }], year: '2020' };

describe('document prose statistics', () => {
  it('counts prose, normalized Unicode characters, paragraphs, approximate sentences and headings', () => {
    const counts = documentStatistics('# Title\n\nHello, world!\n\nAnother sentence. Two more?');
    expect(counts.textOnly).toEqual({ words: 7, characters: 47, charactersWithoutSpaces: 41 });
    expect(counts.includingCitations).toEqual(counts.textOnly);
    expect(counts).toMatchObject({ paragraphs: 2, sentences: 3, headings: 1 });
  });

  it('excludes YAML frontmatter, fenced chunks, indented code and raw-format blocks', () => {
    const source = ['---', 'title: Hidden title', 'abstract: metadata', '---', '', 'Body text.', '', '```{r}', '#| fig-cap: Hidden code', 'print("not words")', '```', '', '~~~python', 'hidden', '~~~~', '', '    indented code', '', '```{=html}', '<b>raw</b>', '```'].join('\n');
    expect(documentStatistics(source)).toMatchObject({ textOnly: { words: 2 }, headings: 0, citations: 0 });
  });

  it('excludes code inside nested divs without treating code fences as refs divs', () => {
    const source = '::: {.callout-note}\nVisible text\n\n```\n::: {#refs}\n# References\n```\n\nMore text\n:::\n\nLast words';
    expect(documentStatistics(source).textOnly.words).toBe(6);
  });

  it('counts each inline code span once while preserving its visible characters', () => {
    const counts = documentStatistics('Use `alpha + beta` and ``some ` code``.');
    expect(counts.textOnly.words).toBe(4);
    expect(counts.textOnly.characters).toBe('Use alpha + beta and some ` code.'.length);
    expect(documentStatistics('before`two words`after').textOnly.words).toBe(3);
    expect(documentStatistics('`@fake $x$ <!-- literal -->`').equations).toBe(0);
  });

  it('excludes multiline comments but preserves inline code containing comments', () => {
    const counts = documentStatistics('One <!-- hidden\n@fake --> two.\n\n<!-- hidden -->\n\n`<!-- literal -->`');
    expect(counts.textOnly.words).toBe(3);
    expect(counts.citations).toBe(0);
    expect(counts.paragraphs).toBe(2);
  });

  it('counts citations, unique keys, and the same author/year labels as the preview', async () => {
    const source = 'A result [@peron2020]. @peron2020 agrees [@other].';
    const options = { citations: [citation, { key: 'other', author: 'Other, Amy', year: '2021' }] };
    const counts = documentStatistics(source, options);
    expect(counts.textOnly.words).toBe(3);
    expect(counts.includingCitations.words).toBe(13);
    expect(counts).toMatchObject({ citations: 3, uniqueCitationKeys: ['peron2020', 'other'] });
    const snapshot = new DocumentSession(workspacePath('synthetic.qmd'), source).snapshot();
    const rendered = await new BasicDocumentEngine().render({ snapshot, citations: options.citations });
    expect(rendered.html).toContain('Péron et al., 2020');
    expect(rendered.html).toContain('Péron et al. (2020)');
    const onlyCitation = documentStatistics('[@peron2020]', { citations: [citation] });
    expect(onlyCitation.textOnly).toEqual({ words: 0, characters: 0, charactersWithoutSpaces: 0 });
    expect(onlyCitation.includingCitations).toEqual({ words: 4, characters: [...'(Péron et al., 2020)'].length, charactersWithoutSpaces: [...'(Péronetal.,2020)'].length });
  });

  it('handles grouped, narrative, suppressed-author and unresolved citations, excluding emails and escapes', () => {
    const counts = documentStatistics('See [e.g. @peron2020; @other, p. 2], -@peron2020 and @missing. mail@example.com \\@literal.', { citations: [citation] });
    expect(counts.citations).toBe(4);
    expect(counts.uniqueCitationKeys).toEqual(['peron2020', 'other', 'missing']);
  });

  it('excludes cross-references from both text variants and counts them separately', () => {
    const counts = documentStatistics('See @fig-one, @tbl-two, @eq-three and @sec-four.');
    expect(counts).toMatchObject({ crossReferences: 4, citations: 0 });
    expect(counts.textOnly.words).toBe(2);
    expect(counts.includingCitations).toEqual(counts.textOnly);
  });

  it('excludes the refs div including nested divs and leaves following prose', () => {
    const counts = documentStatistics('Body.\n\n::: {#refs}\nBibliography entry @hidden\n\n::: {.nested}\nMore references\n:::\n:::\n\nAfter.');
    expect(counts).toMatchObject({ textOnly: { words: 2 }, citations: 0 });
  });

  it.each(['References', 'Bibliography'])('excludes a final %s heading section and nested headings', (heading) => {
    const counts = documentStatistics(`# Body\n\nVisible.\n\n# ${heading} {#refs}\nHidden entry\n\n## Books\nMore hidden`);
    expect(counts).toMatchObject({ textOnly: { words: 2 }, headings: 1 });
  });

  it('keeps a non-final References heading when a peer body section follows', () => {
    expect(documentStatistics('# References\n\nDiscussion.\n\n# Results\n\nFindings.').textOnly.words).toBe(4);
  });

  it('counts image captions optionally, excluding link destinations and attributes', () => {
    const source = 'Body words.\n\n![A *useful* caption](plots/a.png "not prose") {#fig-one .wide width=90%}';
    expect(documentStatistics(source)).toMatchObject({ figures: 1, textOnly: { words: 5 } });
    expect(documentStatistics(source, { includeCaptions: false })).toMatchObject({ figures: 1, textOnly: { words: 2 } });
  });

  it('counts table cell prose, excludes pipes/separators, and toggles table captions', () => {
    const source = '| Name | Value |\n| :--- | ---: |\n| Alpha | 12 |\n\n: Measured values {#tbl-values}';
    expect(documentStatistics(source)).toMatchObject({ tables: 1, textOnly: { words: 6 } });
    expect(documentStatistics(source, { includeCaptions: false })).toMatchObject({ tables: 1, textOnly: { words: 4 } });
  });

  it('uses Unicode segmentation for CJK, accents, apostrophes, numbers and combining marks', () => {
    expect(countWords('你好世界')).toBe([...new Intl.Segmenter(undefined, { granularity: 'word' }).segment('你好世界')].filter((part) => part.isWordLike).length);
    expect(countWords('Péron café cafe\u0301 2020')).toBe(4);
    expect(countWords("l’été don't 12.5")).toBe(3);
    expect(countWords('Péron cafe\u0301 42 day--night', null)).toBe(4);
  });

  it('merges hyphenated/en-dash compounds while em dashes separate words', () => {
    expect(documentStatistics('day--night day–night day-night day—night').textOnly.words).toBe(5);
  });

  it('counts labels, emphasis, escaped syntax, entities, lists and quotes as prose', () => {
    const source = '# *Heading* {#sec-id .unnumbered}\n\n- **Bold** and _italic_\n- [Link label](https://example.test/hidden "title")\n\n> Quoted &amp; text\n\n<span>Inline HTML</span>';
    expect(documentStatistics(source)).toMatchObject({ headings: 1, textOnly: { words: 10 } });
    expect(documentStatistics('**one** _two_ ~~three~~').textOnly.words).toBe(3);
  });

  it('excludes bare URLs, autolinks, and link/image URL parts but resolves reference labels', () => {
    const source = 'Read [the guide][guide]. https://example.test/path?q=words <https://other.test>\n\n[guide]: https://example.test/hidden "not prose"\n\n![Caption][image]\n\n[image]: figures/chart.png';
    const counts = documentStatistics(source);
    expect(counts.textOnly.words).toBe(4);
    expect(counts.figures).toBe(1);
  });

  it('excludes raw HTML/LaTeX blocks and counts math independently of TeX tokens', () => {
    const source = 'Body $x$ and $y_i + z$.\n\n$$\n\\alpha + x\n\n+ y\n$$ {#eq-one}\n\n\\[z = 1\\]\n\n\\begin{equation}\nx+y\n\\end{equation}\n\n<div>\nHidden HTML @fake\n</div>\n\n\\begin{tabular}\nHidden latex\n\\end{tabular}';
    expect(documentStatistics(source)).toMatchObject({ textOnly: { words: 2 }, equations: 5, citations: 0 });
  });

  it('excludes raw HTML across blank lines and ignores fake headings/fences inside it', () => {
    const source = 'Body.\n\n<div>\nHidden\n\n# References\n::: {#refs}\n<div>Nested</div>\n</div>\n\nAfter.';
    expect(documentStatistics(source)).toMatchObject({ textOnly: { words: 2 }, headings: 0 });
    const start = source.indexOf('Hidden');
    expect(documentStatistics(source, { selection: { from: start, to: start + 6 } }).textOnly.words).toBe(0);
  });

  it('excludes final setext bibliographies and counts setext H1 sections', () => {
    const source = 'Introduction\n============\n\nBody.\n\nReferences\n==========\n\nHidden entry.';
    expect(documentStatistics(source)).toMatchObject({ textOnly: { words: 2 }, headings: 1, sections: [{ label: 'Introduction', from: 0, words: 2 }] });
  });

  it('counts footnote identities once and includes footnote prose', () => {
    const counts = documentStatistics('Body[^note] again[^note].\n\n[^note]: Footnote prose.');
    expect(counts).toMatchObject({ footnotes: 1, textOnly: { words: 4 } });
  });

  it('uses source selection offsets and keeps a selection inside excluded code empty', () => {
    const source = '---\ntitle: hidden\n---\n\nFirst second third.\n\n```\nhidden code words\n```';
    const start = source.indexOf('second');
    expect(documentStatistics(source, { selection: { from: start, to: start + 6 } }).textOnly.words).toBe(1);
    const codeStart = source.indexOf('hidden code');
    expect(documentStatistics(source, { selection: { from: codeStart, to: codeStart + 17 } }).textOnly.words).toBe(0);
  });

  it('reports H1 section words including nested sections and correct original block positions', () => {
    const source = 'Preamble.\n\n# Introduction {#sec-intro}\n\nOne two.\n\n## Nested\n\nThree.\n\n# Results\n\nFour five.';
    const snapshot = new DocumentSession(workspacePath('synthetic.qmd'), source).snapshot();
    const counts = documentStatistics(snapshot);
    expect(counts.sections).toEqual([
      { label: 'Introduction', from: source.indexOf('# Introduction'), blockId: snapshot.blocks.find((block) => block.text.startsWith('# Introduction'))!.id, words: 5 },
      { label: 'Results', from: source.indexOf('# Results'), blockId: snapshot.blocks.find((block) => block.text.startsWith('# Results'))!.id, words: 3 },
    ]);
  });

  it('keeps source offsets across Unicode, CRLF, hidden metadata, comments and div fences', () => {
    const source = '---\r\ntitle: café\r\n---\r\n\r\n<!-- hidden -->\r\n\r\n::: {.callout-note}\r\n# Café\r\n\r\nBody.\r\n:::';
    expect(documentStatistics(source).sections[0]?.from).toBe(source.indexOf('# Café'));
  });

  it('reuses unchanged block counts after an edit and invalidates for captions and citation labels', () => {
    const calculator = new DocumentStatisticsCalculator();
    const segment = vi.spyOn(Intl.Segmenter.prototype, 'segment');
    try {
      const source = '# Title\n\nStable paragraph.\n\nChanging paragraph.';
      calculator.calculate(source);
      segment.mockClear();
      const next = source.replace('Changing', 'Changed');
      const result = calculator.calculate(next);
      const incrementalCalls = segment.mock.calls.length;
      segment.mockClear();
      expect(result).toEqual(documentStatistics(next));
      expect(incrementalCalls).toBeLessThan(segment.mock.calls.length);
      expect(calculator.calculate('[@peron2020]', { citations: [citation] }).includingCitations.words).toBe(4);
      expect(calculator.calculate('[@peron2020]', { citations: [{ key: 'peron2020', author: 'Test', year: '2022' }] }).includingCitations.words).toBe(2);
      expect(calculator.calculate('![Caption](x.png)', { includeCaptions: false }).textOnly.words).toBe(0);
    } finally { segment.mockRestore(); }
  });

  it('returns zero counts for empty or excluded documents', () => {
    expect(documentStatistics('')).toMatchObject({ textOnly: { words: 0, characters: 0, charactersWithoutSpaces: 0 }, paragraphs: 0, sentences: 0, sections: [] });
    expect(documentStatistics('```\nOnly code\n```').textOnly.words).toBe(0);
  });
});
