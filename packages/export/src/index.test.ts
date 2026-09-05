import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserDocumentExporter, exportFilename, parseExportOptions, preparePandocInput } from './index.js';

const { convert } = vi.hoisted(() => ({ convert: vi.fn() }));

vi.mock('pandoc-wasm', () => ({ convert }));

describe('browser document export', () => {
  beforeEach(() => convert.mockReset());

  it('uses flat temporary files while preserving nested source references by extension', () => {
    const prepared = preparePandocInput(
      '![Plot](../figures/result.pdf)\n\nbibliography: ../references/library.bib',
      [
        { path: '../figures/result.pdf', content: new Blob(['png'], { type: 'image/png' }) },
        { path: '../references/library.bib', content: new Blob(['@article{x}'], { type: 'text/plain' }) },
      ],
    );

    expect(prepared.source).toBe('![Plot](markroot-resource-1.png)\n\nbibliography: markroot-resource-2.bib');
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
});
