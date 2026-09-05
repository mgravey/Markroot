import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserDocumentExporter, exportFilename, preparePandocInput } from './index.js';

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

    const result = await new BrowserDocumentExporter().export({
      format: 'docx',
      source: '# Report',
      filename: 'chapters/results/report.qmd',
    });

    expect(result.filename).toBe('report.docx');
    expect(result.blob.size).toBe(4);
    expect(convert).toHaveBeenCalledWith(expect.objectContaining({ 'output-file': 'report.docx' }), '# Report', {});
  });

  it.each(['html', 'pdf'] as const)('rejects empty %s Pandoc output with stderr details', async (format) => {
    convert.mockResolvedValue({ stdout: '', stderr: 'resource not found', warnings: [], files: {}, mediaFiles: {} });

    await expect(new BrowserDocumentExporter().export({ format, source: '# Report', filename: 'report.qmd' }))
      .rejects.toThrow('resource not found');
  });

  it('always returns a leaf output filename', () => {
    expect(exportFilename('chapters\\results/paper.qmd', 'html')).toBe('paper.html');
  });
});
