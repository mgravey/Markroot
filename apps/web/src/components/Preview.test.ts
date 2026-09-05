import { describe, expect, it } from 'vitest';
import { mapRenderedOffset, mapSourceOffset, opensExternalPage, protectLocalObjectUrls, trustedDoiUrl } from './preview-utils.js';

describe('preview local resources', () => {
  it('protects only Markroot-created object URLs while HTML is sanitized', () => {
    const local = 'blob:http://127.0.0.1:5173/markroot-local-image';
    const other = 'blob:http://127.0.0.1:5173/untrusted-image';
    const html = `<figure><img src="${local}" alt="Local"><img src="${other}" alt="Other"></figure>`;

    expect(protectLocalObjectUrls(html, [local])).toBe(
      `<figure><img data-markroot-object-url="0" alt="Local"><img src="${other}" alt="Other"></figure>`,
    );
  });

  it('keeps document fragments inside the viewer', () => {
    expect(opensExternalPage('#sec-results')).toBe(false);
    expect(opensExternalPage('https://example.com/paper')).toBe(true);
  });

  it('allows modified citation clicks only for canonical DOI links', () => {
    expect(trustedDoiUrl('https://doi.org/10.1234/example.7')).toBe('https://doi.org/10.1234/example.7');
    expect(trustedDoiUrl('https://example.com/10.1234/example.7')).toBeUndefined();
    expect(trustedDoiUrl('javascript:alert(1)')).toBeUndefined();
  });

  it('maps rendered prose selections back inside Markdown formatting', () => {
    const source = 'A **carefully written** sentence.\n';
    const rendered = 'A carefully written sentence.';
    const from = rendered.indexOf('carefully');
    const to = from + 'carefully written'.length;

    expect(mapRenderedOffset(source, rendered, from)).toBe(source.indexOf('carefully'));
    expect(mapRenderedOffset(source, rendered, to)).toBe(source.indexOf('carefully written') + 'carefully written'.length);
    expect(mapSourceOffset(source, rendered, source.indexOf('carefully'))).toBe(from);
    expect(mapSourceOffset(source, rendered, source.indexOf('carefully written') + 'carefully written'.length)).toBe(to);
  });
});
