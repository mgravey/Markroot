import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserDocumentExporter, exportFilename, parseExportOptions, preparePandocInput } from './index.js';

const { convert, typst } = vi.hoisted(() => ({
  convert: vi.fn(),
  typst: { instances: [] as Array<Record<string, ReturnType<typeof vi.fn>>>, failInit: 0, log: [] as string[] },
}));

vi.mock('pandoc-wasm', () => ({ convert }));
vi.mock('@myriaddreamin/typst.ts', () => ({ MemoryAccessModel: class {} }));
vi.mock('@myriaddreamin/typst.ts/contrib/snippet', () => ({
  TypstSnippet: class {
    static withAccessModel() { return {}; }
    static preloadFontData() { return {}; }
    use = vi.fn();
    setCompilerInitOptions = vi.fn();
    getCompiler = vi.fn(async () => { if (typst.failInit > 0) { typst.failInit -= 1; throw new Error('wasm init failed'); } });
    resetShadow = vi.fn(async () => { typst.log.push('reset'); });
    mapShadow = vi.fn(async (path: string) => { typst.log.push(`map ${path}`); await new Promise((resolve) => setTimeout(resolve, 1)); });
    pdf = vi.fn(async () => { typst.log.push('pdf'); return new Uint8Array([37, 80, 68, 70]); });
    constructor() { typst.instances.push(this as unknown as Record<string, ReturnType<typeof vi.fn>>); }
  },
}));

describe('browser document export', () => {
  beforeEach(() => convert.mockReset());

  it('uses flat temporary files while preserving nested source references by extension', () => {
    const prepared = preparePandocInput(
      '---\nbibliography: ../references/library.bib\n---\n![Plot](../figures/result.pdf)',
      [
        { path: '../figures/result.pdf', content: new Blob(['png'], { type: 'image/png' }) },
        { path: '../references/library.bib', content: new Blob(['@article{x}'], { type: 'text/plain' }) },
      ],
    );

    expect(prepared.source).toBe('---\nbibliography: markroot-resource-2.bib\n---\n![Plot](markroot-resource-1.png)');
    expect(Object.keys(prepared.files)).toEqual(['markroot-resource-1.png', 'markroot-resource-2.bib']);
  });

  it('returns a DOCX from a document stored in a nested folder', async () => {
    convert.mockResolvedValue({ stdout: '', stderr: '', warnings: [], files: { 'report.docx': new Blob(['docx']) }, mediaFiles: {} });
    const progress = vi.fn();

    const result = await new BrowserDocumentExporter().export({
      format: 'docx',
      source: '# Report',
      filename: 'chapters/results/report.qmd',
    }, { onProgress: progress });

    expect(result.filename).toBe('report.docx');
    expect(result.blob.size).toBe(4);
    expect(convert).toHaveBeenCalledWith(expect.objectContaining({ 'output-file': 'report.docx' }), '# Report', {});
    expect(progress.mock.calls.map(([event]) => [event.phase, event.completed, event.total])).toEqual([
      ['prepare', 0, 2],
      ['pandoc', 1, 2],
      ['complete', 2, 2],
    ]);
  });

  it.each(['html', 'pdf'] as const)('rejects empty %s Pandoc output with stderr details', async (format) => {
    convert.mockResolvedValue({ stdout: '', stderr: 'resource not found', warnings: [], files: {}, mediaFiles: {} });

    await expect(new BrowserDocumentExporter().export({ format, source: '# Report', filename: 'report.qmd' }))
      .rejects.toThrow('resource not found');
  });

  it('always returns a leaf output filename', () => {
    expect(exportFilename('chapters\\results/paper.qmd', 'html')).toBe('paper.html');
  });

  it('reads format-specific template resources from YAML front matter', () => {
    expect(parseExportOptions(`---
format:
  docx:
    reference-doc: "templates/report.docx"
  html:
    template: templates/report.html
    css:
      - styles/base.css
      - styles/print.css
  typst:
    template: templates/report.typ
    template-partials: [templates/page.typ, templates/title.typ]
---`)).toEqual({
      referenceDocx: 'templates/report.docx',
      htmlTemplate: 'templates/report.html',
      htmlCss: ['styles/base.css', 'styles/print.css'],
      typstTemplate: 'templates/report.typ',
      typstTemplatePartials: ['templates/page.typ', 'templates/title.typ'],
    });
  });

  it('applies HTML justification only when no explicit HTML styling is provided', async () => {
    convert.mockResolvedValue({ stdout: '<html><head></head><body><p>Report</p></body></html>', stderr: '', warnings: [], files: {}, mediaFiles: {} });
    const result = await new BrowserDocumentExporter().export({ format: 'html', source: '# Report', filename: 'report.qmd', justified: true });
    expect(await result.blob.text()).toContain('p { text-align: justify; }');

    const styled = await new BrowserDocumentExporter().export({
      format: 'html', source: '# Report', filename: 'report.qmd', justified: true,
      htmlCss: ['report.css'], resources: [{ path: 'report.css', content: 'p { text-align: right; }' }],
    });
    expect(await styled.blob.text()).not.toContain('data-markroot-export');
    expect(convert).toHaveBeenLastCalledWith(
      expect.objectContaining({ css: ['markroot-resource-1.css'] }),
      '# Report',
      { 'markroot-resource-1.css': 'p { text-align: right; }' },
    );
  });

  it('gives an explicit DOCX reference precedence over justification defaults', async () => {
    convert.mockResolvedValue({ stdout: '', stderr: '', warnings: [], files: { 'report.docx': new Blob(['docx']) }, mediaFiles: {} });
    const template = new Blob(['reference'], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

    await new BrowserDocumentExporter().export({
      format: 'docx', source: '# Report', filename: 'report.qmd', justified: true,
      referenceDocx: 'templates/report.docx', resources: [{ path: 'templates/report.docx', content: template }],
    });

    expect(convert).toHaveBeenCalledWith(
      expect.objectContaining({ 'reference-doc': 'markroot-resource-1.docx' }),
      '# Report',
      { 'markroot-resource-1.docx': template },
    );
  });

  it('uses the bundled justified DOCX reference when no explicit template is set', async () => {
    convert.mockResolvedValue({ stdout: '', stderr: '', warnings: [], files: { 'report.docx': new Blob(['docx']) }, mediaFiles: {} });
    const fetchReference = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Blob(['reference']), { status: 200 }));

    await new BrowserDocumentExporter().export({ format: 'docx', source: '# Report', filename: 'report.qmd', justified: true });

    expect(fetchReference).toHaveBeenCalledOnce();
    expect(convert).toHaveBeenCalledWith(
      expect.objectContaining({ 'reference-doc': 'markroot-justified-reference.docx' }),
      '# Report',
      expect.objectContaining({ 'markroot-justified-reference.docx': expect.any(Blob) }),
    );
    fetchReference.mockRestore();
  });

  it('rewrites only destinations and front-matter values, never prose, code or longer names', () => {
    const prepared = preparePandocInput([
      '---', 'bibliography: refs.bib', 'css: [a.png, "b.css"]', '---',
      'See a.png and data.png in prose. ![A](a.png) ![D](data.png) [link](./a.png "t") ![B](<b c.png>)',
      '[ref]: a.png', '<img src="a.png">', '```', '![A](a.png)', '```', '',
    ].join('\n'), [
      { path: 'a.png', content: 'A' }, { path: 'refs.bib', content: '@misc{x}' }, { path: 'b.css', content: 'p{}' }, { path: 'b c.png', content: 'B' },
    ]);
    expect(prepared.source).toBe([
      '---', 'bibliography: markroot-resource-2.bib', 'css: [markroot-resource-1.png, "markroot-resource-3.css"]', '---',
      'See a.png and data.png in prose. ![A](markroot-resource-1.png) ![D](data.png) [link](markroot-resource-1.png "t") ![B](<markroot-resource-4.png>)',
      '[ref]: markroot-resource-1.png', '<img src="markroot-resource-1.png">', '```', '![A](a.png)', '```', '',
    ].join('\n'));
  });

  it('passes Typst template partials to Pandoc beside the flattened template', async () => {
    convert.mockResolvedValue({ stdout: '= Report', stderr: '', warnings: [], files: {}, mediaFiles: {} });
    const fetchFont = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Blob(['font']), { status: 200 }));
    await new BrowserDocumentExporter().export({
      format: 'pdf', source: '# Report', filename: 'report.qmd', typstTemplate: 'templates/report.typ', typstTemplatePartials: ['templates/page.typ'],
      resources: [{ path: 'templates/report.typ', content: '$page()$' }, { path: 'templates/page.typ', content: 'PAGE' }],
    });
    expect(convert).toHaveBeenCalledWith(expect.objectContaining({ template: 'markroot-resource-1.typ' }), '# Report', expect.objectContaining({ 'page.typ': 'PAGE', 'markroot-resource-1.typ': '$page()$' }));
    fetchFont.mockRestore();
  });

  describe('PDF compiler lifecycle', () => {
    afterEach(() => vi.restoreAllMocks());

    it('retries Typst initialization after a failure and serializes concurrent compiles', async () => {
      convert.mockResolvedValue({ stdout: '= Report', stderr: '', warnings: [], files: {}, mediaFiles: {} });
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(new Blob(['font']), { status: 200 }));
      vi.resetModules();
      const { BrowserDocumentExporter: FreshExporter } = await import('./index.js');
      const exporter = new FreshExporter();
      typst.failInit = 1;
      const created = typst.instances.length;
      await expect(exporter.export({ format: 'pdf', source: '# A', filename: 'a.qmd' })).rejects.toThrow(/wasm init failed/);
      typst.failInit = 0;
      typst.log.length = 0;
      const resources = [{ path: 'x.txt', content: 'x' }];
      const results = await Promise.all([
        exporter.export({ format: 'pdf', source: '# A', filename: 'a.qmd', resources }),
        exporter.export({ format: 'pdf', source: '# B', filename: 'b.qmd', resources }),
      ]);
      expect(results.map((result) => result.blob.type)).toEqual(['application/pdf', 'application/pdf']);
      expect(typst.instances.length - created).toBe(2);
      expect(typst.log).toEqual(['reset', 'map /main.typ', 'map /markroot-resource-1.txt', 'pdf', 'reset', 'map /main.typ', 'map /markroot-resource-1.txt', 'pdf']);
    });
  });
});
