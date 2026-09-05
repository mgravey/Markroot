export function mapRenderedOffset(source: string, rendered: string, renderedOffset: number): number {
  const isWord = (value: string) => /[\p{L}\p{N}'’_-]/u.test(value);
  let start = Math.max(0, Math.min(renderedOffset, rendered.length));
  let end = start;
  while (start > 0 && isWord(rendered[start - 1]!)) start -= 1;
  while (end < rendered.length && isWord(rendered[end]!)) end += 1;
  const word = rendered.slice(start, end);
  if (word.length >= 2) {
    const candidates: number[] = [];
    const lowerSource = source.toLocaleLowerCase();
    const lowerWord = word.toLocaleLowerCase();
    let index = lowerSource.indexOf(lowerWord);
    while (index >= 0) { candidates.push(index); index = lowerSource.indexOf(lowerWord, index + lowerWord.length); }
    if (candidates.length) {
      const expected = source.length * (renderedOffset / Math.max(1, rendered.length));
      const match = candidates.reduce((best, candidate) => Math.abs(candidate - expected) < Math.abs(best - expected) ? candidate : best);
      return Math.min(source.length, match + Math.max(0, renderedOffset - start));
    }
  }
  return Math.round(source.length * (renderedOffset / Math.max(1, rendered.length)));
}

export function mapSourceOffset(source: string, rendered: string, sourceOffset: number): number {
  const target = Math.max(0, Math.min(sourceOffset, source.length));
  const isWord = (value: string) => /[\p{L}\p{N}'’_-]/u.test(value);
  let start = target;
  let end = target;
  while (start > 0 && isWord(source[start - 1]!)) start -= 1;
  while (end < source.length && isWord(source[end]!)) end += 1;
  const word = source.slice(start, end);
  if (word.length >= 2) {
    const candidates: number[] = [];
    const lowerRendered = rendered.toLocaleLowerCase();
    const lowerWord = word.toLocaleLowerCase();
    let index = lowerRendered.indexOf(lowerWord);
    while (index >= 0) {
      candidates.push(index);
      index = lowerRendered.indexOf(lowerWord, index + lowerWord.length);
    }
    if (candidates.length) {
      const expected = rendered.length * (target / Math.max(1, source.length));
      const match = candidates.reduce((best, candidate) => Math.abs(candidate - expected) < Math.abs(best - expected) ? candidate : best);
      return Math.min(rendered.length, match + Math.max(0, target - start));
    }
  }
  return Math.round(rendered.length * (target / Math.max(1, source.length)));
}

export function protectLocalObjectUrls(html: string, objectUrls: readonly string[]): string {
  return objectUrls.reduce(
    (protectedHtml, url, index) => protectedHtml.replaceAll(`src="${url}"`, `data-markroot-object-url="${index}"`),
    html,
  );
}

export function opensExternalPage(href: string): boolean { return /^https?:\/\//i.test(href); }

export function trustedDoiUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'doi.org' && /^\/10\.\d{4,9}\//i.test(url.pathname) ? url.href : undefined;
  } catch { return undefined; }
}
