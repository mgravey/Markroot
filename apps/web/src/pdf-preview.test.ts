import { describe, expect, it } from 'vitest';
import { isPdfFigurePath, pdfPreviewScale } from './pdf-preview.js';

describe('PDF figure previews', () => {
  it('recognizes local PDF figure paths case-insensitively', () => {
    expect(isPdfFigurePath('figures/result.pdf')).toBe(true);
    expect(isPdfFigurePath('figures/RESULT.PDF')).toBe(true);
    expect(isPdfFigurePath('figures/result.png')).toBe(false);
  });

  it('renders a normal page sharply while bounding large canvases', () => {
    expect(pdfPreviewScale(600, 800)).toBe(3);
    expect(pdfPreviewScale(2_000, 4_000)).toBe(0.6);
  });
});
