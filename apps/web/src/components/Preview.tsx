import { useEffect, useRef } from 'react';
import DOMPurify from 'dompurify';
import type { DocumentBlock } from '@markroot/document';
import { centeredScrollTop, isScrollKey, ScrollIntentGate, viewportCenter } from './scroll-sync.js';

interface Props {
  html: string;
  objectUrls: readonly string[];
  warnings: readonly string[];
  blocks: readonly DocumentBlock[];
  search: string;
  regularExpression: boolean;
  activeBlock?: string | undefined;
  scrollTarget?: string | undefined;
  scrollProgress?: number | undefined;
  scrollAlignment: 'center' | 'reveal';
  anchorTarget?: Readonly<{ id: string; request: number }> | undefined;
  allowRemoteResources: boolean;
  fontFamily: 'serif' | 'sans' | 'mono';
  fontSize: number;
  justified: boolean;
  onNavigate(id: string, sourceOffset?: number): void;
  onScroll(id: string, progress: number): void;
}

export function Preview({ html, objectUrls, warnings, blocks, search, regularExpression, activeBlock, scrollTarget, scrollProgress, scrollAlignment, anchorTarget, allowRemoteResources, fontFamily, fontSize, justified, onNavigate, onScroll }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const scrollIntent = useRef(new ScrollIntentGate());
  const latestOnScroll = useRef(onScroll);
  const latestOnNavigate = useRef(onNavigate);
  latestOnScroll.current = onScroll;
  latestOnNavigate.current = onNavigate;
  useEffect(() => {
    if (!host.current) return;
    const shadow = host.current.shadowRoot ?? host.current.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = previewStyle;
    const article = document.createElement('article');
    article.classList.toggle('justified', justified);
    article.innerHTML = DOMPurify.sanitize(protectLocalObjectUrls(html, objectUrls), { FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed'], FORBID_ATTR: ['style'] });
    restoreLocalObjectUrls(article, objectUrls);
    secureLinks(article);
    if (!allowRemoteResources) blockRemoteResources(article);
    prepareFigureImages(article);
    appendViewerWarnings(article, warnings);
    if (search) highlight(article, search, regularExpression);
    if (activeBlock) article.querySelector(`[data-block-id="${CSS.escape(activeBlock)}"]`)?.classList.add('active-block');
    shadow.host instanceof HTMLElement && shadow.host.style.setProperty('--viewer-font', fontStack(fontFamily));
    shadow.host instanceof HTMLElement && shadow.host.style.setProperty('--viewer-size', `${fontSize}px`);
    shadow.replaceChildren(style, article);
  }, [html, objectUrls, warnings, search, regularExpression, allowRemoteResources, fontFamily, fontSize, justified]);
  useEffect(() => {
    const shadow = host.current?.shadowRoot;
    shadow?.querySelectorAll('.active-block').forEach((element) => element.classList.remove('active-block'));
    if (activeBlock) shadow?.querySelector(`[data-block-id="${CSS.escape(activeBlock)}"]`)?.classList.add('active-block');
  }, [activeBlock, html]);
  useEffect(() => {
    const target = scrollTarget ? host.current?.shadowRoot?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(scrollTarget)}"]`) : undefined;
    if (target) {
      const container = host.current?.parentElement;
      const next = target.nextElementSibling instanceof HTMLElement ? target.nextElementSibling : undefined;
      scrollIntent.current.beginProgrammatic();
      const moved = container ? (scrollAlignment === 'center' ? centerPoint : revealPoint)(container, target, next, scrollProgress ?? 0) : (target.scrollIntoView({ block: 'center' }), true);
      if (!moved) scrollIntent.current.endProgrammatic();
      else requestAnimationFrame(() => scrollIntent.current.endProgrammatic());
    }
  }, [scrollTarget, scrollProgress, scrollAlignment]);
  useEffect(() => {
    if (anchorTarget) navigatePreviewAnchor(host.current, anchorTarget.id, blocks, scrollIntent.current, latestOnNavigate.current);
  }, [anchorTarget, blocks, html]);
  useEffect(() => {
    const container = host.current?.parentElement;
    if (!container) return;
    let frame = 0;
    const handle = () => {
      if (!scrollIntent.current.shouldPublish()) return;
      scrollIntent.current.continueScroll();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const blocks = [...(host.current?.shadowRoot?.querySelectorAll<HTMLElement>('[data-block-id]') ?? [])];
        if (!blocks.length) return;
        const center = viewportCenter(container.getBoundingClientRect());
        const current = [...blocks].reverse().find((block) => block.getBoundingClientRect().top <= center) ?? blocks[0]!;
        const index = blocks.indexOf(current);
        const next = blocks[index + 1];
        const start = current.getBoundingClientRect().top;
        const span = Math.max(1, (next?.getBoundingClientRect().top ?? current.getBoundingClientRect().bottom) - start);
        latestOnScroll.current(current.dataset.blockId!, Math.max(0, Math.min(1, (center - start) / span)));
      });
    };
    const beginPointer = () => scrollIntent.current.beginPointer();
    const endPointer = () => scrollIntent.current.endPointer();
    const markWheel = () => scrollIntent.current.markIntent();
    const markKeyboard = (event: KeyboardEvent) => { if (isScrollKey(event)) scrollIntent.current.markIntent(); };
    container.addEventListener('scroll', handle, { passive: true });
    container.addEventListener('wheel', markWheel, { passive: true });
    container.addEventListener('pointerdown', beginPointer, { passive: true });
    container.addEventListener('keydown', markKeyboard);
    window.addEventListener('pointerup', endPointer, { passive: true });
    window.addEventListener('pointercancel', endPointer, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      container.removeEventListener('scroll', handle);
      container.removeEventListener('wheel', markWheel);
      container.removeEventListener('pointerdown', beginPointer);
      container.removeEventListener('keydown', markKeyboard);
      window.removeEventListener('pointerup', endPointer);
      window.removeEventListener('pointercancel', endPointer);
    };
  }, [html]);
  return <div className="preview" ref={host} onClick={(event) => {
    const path = event.nativeEvent.composedPath();
    const doiLink = path.find((item): item is HTMLElement => item instanceof HTMLElement && item.hasAttribute('data-doi-url'));
    if (doiLink && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      openTrustedDoi(doiLink.dataset.doiUrl);
      return;
    }
    const link = path.find((item): item is HTMLAnchorElement => item instanceof HTMLAnchorElement);
    const href = link?.getAttribute('href') ?? '';
    if (href.startsWith('#')) {
      event.preventDefault();
      navigatePreviewAnchor(host.current, decodeFragment(href.slice(1)), blocks, scrollIntent.current, onNavigate);
      return;
    }
    if (link) return;
    const block = path.find((item): item is HTMLElement => item instanceof HTMLElement && item.hasAttribute('data-block-id'));
    if (!block?.dataset.blockId) return;
    const mapped = path.find((item): item is HTMLElement => item instanceof HTMLElement && item.hasAttribute('data-source-offset'));
    const exact = mapped?.dataset.sourceOffset ? Number(mapped.dataset.sourceOffset) : undefined;
    const sourceBlock = blocks.find((candidate) => candidate.id === block.dataset.blockId);
    const sourceOffset = Number.isFinite(exact) ? exact : sourceBlock ? sourceOffsetAtPoint(host.current?.shadowRoot, block, sourceBlock, event.clientX, event.clientY) : undefined;
    onNavigate(block.dataset.blockId, sourceOffset);
  }} />;
}

const previewStyle = `
  :host { color: var(--ink); }
  article { min-height: 100%; font-family: var(--viewer-font); font-size: var(--viewer-size); line-height: 1.72; }
  article.justified p, article.justified li, article.justified blockquote { text-align: justify; text-justify: inter-word; hyphens: auto; }
  h1, h2, h3 { line-height: 1.18; letter-spacing: -.02em; }
  h1 { margin-top: .6em; font-size: 2.25em; }
  h2 { margin-top: 1.6em; font-size: 1.55em; }
  h3 { margin-top: 1.45em; font-size: 1.2em; }
  a { color: var(--accent-strong); }
  [data-block-id] { position: relative; margin-inline: -12px; padding-inline: 12px; border-radius: 5px; scroll-margin-block: 40vh; transition: background-color 120ms ease, box-shadow 120ms ease; }
  [data-block-id].active-block { background: color-mix(in srgb, var(--accent) 9%, transparent); box-shadow: -3px 0 0 var(--accent); }
  pre { overflow: auto; padding: 14px; color: #d5e7e2; background: #111a18; border-radius: 7px; }
  code { font-family: 'IBM Plex Mono', monospace; font-size: .86em; }
  :not(pre) > code { padding: .12em .34em; color: var(--accent-strong); background: var(--accent-soft); border-radius: 3px; }
  figure { margin: 1.7em auto; text-align: center; }
  figure img { display: block; max-width: 100%; height: auto; margin: auto; border-radius: 4px; }
  figure.figure-align-left, figure.figure-align-left figcaption { text-align: left; }
  figure.figure-align-left img { margin-left: 0; margin-right: auto; }
  figure.figure-align-right, figure.figure-align-right figcaption { text-align: right; }
  figure.figure-align-right img { margin-left: auto; margin-right: 0; }
  figcaption { max-width: 68ch; margin: .65em auto 0; color: var(--muted); font-size: .88em; line-height: 1.45; text-align: center; }
  figure[data-caption-location="top"] figcaption { margin-top: 0; margin-bottom: .65em; }
  .figure-label { color: var(--ink); font-weight: 600; }
  .section-number { margin-right: .18em; color: var(--accent-strong); font-variant-numeric: tabular-nums; }
  .table-figure { text-align: left; }
  .table-figure figcaption { max-width: none; margin: 0 0 .55em; text-align: left; }
  .table-label { color: var(--ink); font-weight: 600; }
  .table-scroll { overflow-x: auto; }
  .image-missing { display: grid; place-items: center; min-height: 150px; padding: 22px; color: var(--muted); background: color-mix(in srgb, var(--surface-strong) 76%, transparent); border: 1px dashed var(--line-strong); border-radius: 6px; font-family: 'Manrope', sans-serif; text-align: center; }
  .image-missing strong { color: var(--ink); font-size: .86em; }
  .image-missing code { max-width: 100%; margin-top: .4em; overflow-wrap: anywhere; color: var(--muted); background: transparent; }
  .viewer-warnings { margin: 0 0 1.3em; padding: .65em .8em; color: var(--muted); background: var(--surface-strong); border: 1px solid var(--line); border-radius: 6px; font: .76em/1.45 'Manrope', sans-serif; }
  .viewer-warnings summary { cursor: pointer; color: var(--ink); font-weight: 600; }
  .viewer-warnings ul { margin: .55em 0 0; padding-left: 1.3em; }
  .figure-layout { display: grid; gap: 1.25em; align-items: start; }
  .figure-layout.layout-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .figure-layout.layout-cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .figure-layout.layout-cols-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .figure-layout figure { margin-block: .7em; }
  .math-inline { display: inline-flex; align-items: baseline; margin-inline: .08em; }
  .math-display { position: relative; display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 1em; margin: 1.35em 0; overflow-x: auto; padding: .6em 0; }
  .math-display > .katex { justify-self: center; }
  .equation-number { color: var(--muted); font-size: .86em; font-variant-numeric: tabular-nums; }
  math { font-size: 1.06em; }
  .citation a { color: var(--accent-strong); text-decoration: none; border-bottom: 1px dotted currentColor; }
  .doi-link { overflow-wrap: anywhere; font-size: .86em; }
  .references { margin-top: 3em; padding-top: 1em; border-top: 1px solid var(--line); }
  .references.references-explicit { margin-top: 0; padding-top: 0; border-top: 0; }
  .references ol { padding-left: 1.4em; }
  .references li { margin: .7em 0; padding-left: .35em; }
  table { width: 100%; margin: 1.4em 0; border-collapse: collapse; font-size: .94em; }
  th, td { padding: .55em .7em; border-bottom: 1px solid var(--line); text-align: left; }
  th { font-family: 'Manrope', sans-serif; font-size: .86em; letter-spacing: .02em; }
  tbody tr:hover { background: color-mix(in srgb, var(--accent) 6%, transparent); }
  mark { color: inherit; background: #ffd76a; border-radius: 2px; }
  .remote-resource-placeholder { display: block; padding: 16px; color: var(--muted); background: var(--surface-strong); border: 1px dashed var(--line-strong); border-radius: 6px; font-family: 'Manrope', sans-serif; font-size: 12px; text-align: center; }
  @media (max-width: 640px) { .figure-layout { grid-template-columns: 1fr !important; } }
`;

function centerPoint(container: HTMLElement, target: HTMLElement, next: HTMLElement | undefined, progress: number): boolean {
  const viewport = container.getBoundingClientRect();
  const rect = target.getBoundingClientRect();
  const span = Math.max(0, (next?.getBoundingClientRect().top ?? rect.bottom) - rect.top);
  const point = rect.top + span * Math.max(0, Math.min(1, progress));
  const nextScrollTop = centeredScrollTop(container.scrollTop, point - viewport.top, viewport.height, container.scrollHeight);
  if (Math.abs(nextScrollTop - container.scrollTop) <= 1) return false;
  container.scrollTop = nextScrollTop;
  return true;
}

function revealPoint(container: HTMLElement, target: HTMLElement, next: HTMLElement | undefined, progress: number): boolean {
  const viewport = container.getBoundingClientRect();
  const rect = target.getBoundingClientRect();
  const span = Math.max(0, (next?.getBoundingClientRect().top ?? rect.bottom) - rect.top);
  const point = rect.top + span * Math.max(0, Math.min(1, progress));
  const margin = Math.min(48, viewport.height * .12);
  if (point >= viewport.top + margin && point <= viewport.bottom - margin) return false;
  const nextScrollTop = centeredScrollTop(container.scrollTop, point - viewport.top, viewport.height, container.scrollHeight);
  if (Math.abs(nextScrollTop - container.scrollTop) <= 1) return false;
  container.scrollTop = nextScrollTop;
  return true;
}

function sourceOffsetAtPoint(shadow: ShadowRoot | null | undefined, blockElement: HTMLElement, block: DocumentBlock, x: number, y: number): number {
  if (!shadow) return block.from;
  const documentWithCaret = document as Document & {
    caretPositionFromPoint?(x: number, y: number, options?: { shadowRoots?: readonly ShadowRoot[] }): { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?(x: number, y: number): Range | null;
  };
  const caret = documentWithCaret.caretPositionFromPoint?.(x, y, { shadowRoots: [shadow] });
  const legacy = !caret ? documentWithCaret.caretRangeFromPoint?.(x, y) : undefined;
  let node = caret?.offsetNode ?? legacy?.startContainer;
  let offset = caret?.offset ?? legacy?.startOffset;
  if (!node || offset === undefined || !blockElement.contains(node)) {
    const nearest = nearestTextCaret(blockElement, x, y);
    node = nearest?.node;
    offset = nearest?.offset;
  }
  if (!node || offset === undefined) return block.from;
  const range = document.createRange();
  range.selectNodeContents(blockElement);
  try { range.setEnd(node, offset); }
  catch { return block.from; }
  return block.from + mapRenderedOffset(block.text, blockElement.textContent ?? '', range.toString().length);
}

function nearestTextCaret(root: HTMLElement, x: number, y: number): { node: Text; offset: number } | undefined {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let best: { node: Text; offset: number; distance: number } | undefined;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.length || !node.nodeValue?.trim()) continue;
    const stride = Math.max(1, Math.ceil(node.length / 1024));
    for (let offset = 0; offset <= node.length; offset += stride) {
      const range = document.createRange();
      range.setStart(node, Math.min(offset, node.length));
      range.collapse(true);
      const rect = range.getBoundingClientRect();
      const distance = pointDistance(rect, x, y);
      if (!best || distance < best.distance) best = { node, offset: Math.min(offset, node.length), distance };
    }
  }
  if (!best) return undefined;
  const radius = Math.max(2, Math.ceil(best.node.length / 1024));
  const from = Math.max(0, best.offset - radius);
  const to = Math.min(best.node.length, best.offset + radius);
  for (let offset = from; offset <= to; offset += 1) {
    const range = document.createRange();
    range.setStart(best.node, offset);
    range.collapse(true);
    const distance = pointDistance(range.getBoundingClientRect(), x, y);
    if (distance < best.distance) best = { node: best.node, offset, distance };
  }
  return { node: best.node, offset: best.offset };
}

function pointDistance(rect: DOMRect, x: number, y: number): number {
  const horizontal = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
  const vertical = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
  return horizontal * horizontal + vertical * vertical;
}

function mapRenderedOffset(source: string, rendered: string, renderedOffset: number): number {
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

function fontStack(font: Props['fontFamily']): string {
  if (font === 'mono') return `'IBM Plex Mono', 'SFMono-Regular', Consolas, monospace`;
  if (font === 'sans') return `'Manrope', system-ui, sans-serif`;
  return `'Source Serif 4', Georgia, serif`;
}

function prepareFigureImages(root: HTMLElement): void {
  for (const image of root.querySelectorAll<HTMLImageElement>('img')) {
    const width = image.dataset.figureWidth;
    const height = image.dataset.figureHeight;
    if (safeCssLength(width)) image.style.width = width!;
    if (safeCssLength(height)) image.style.height = height!;
    image.addEventListener('error', () => {
      const source = image.dataset.imageSource ?? image.getAttribute('src') ?? image.alt;
      const placeholder = document.createElement('span');
      placeholder.className = 'image-missing';
      placeholder.setAttribute('role', 'img');
      placeholder.setAttribute('aria-label', `Image unavailable: ${image.alt || source}`);
      const heading = document.createElement('strong');
      heading.textContent = 'Image unavailable';
      const code = document.createElement('code');
      code.textContent = source;
      placeholder.append(heading, code);
      image.replaceWith(placeholder);
    }, { once: true });
  }
}

export function protectLocalObjectUrls(html: string, objectUrls: readonly string[]): string {
  return objectUrls.reduce(
    (protectedHtml, url, index) => protectedHtml.replaceAll(`src="${url}"`, `data-markroot-object-url="${index}"`),
    html,
  );
}

function restoreLocalObjectUrls(root: HTMLElement, objectUrls: readonly string[]): void {
  for (const element of root.querySelectorAll<HTMLElement>('[data-markroot-object-url]')) {
    const index = Number.parseInt(element.dataset.markrootObjectUrl ?? '', 10);
    element.removeAttribute('data-markroot-object-url');
    if (!(element instanceof HTMLImageElement) || !Number.isInteger(index) || index < 0 || index >= objectUrls.length) continue;
    element.src = objectUrls[index]!;
  }
}

function appendViewerWarnings(root: HTMLElement, warnings: readonly string[]): void {
  if (!warnings.length) return;
  const details = document.createElement('details');
  details.className = 'viewer-warnings';
  const summary = document.createElement('summary');
  summary.textContent = `${warnings.length} viewer ${warnings.length === 1 ? 'note' : 'notes'}`;
  const list = document.createElement('ul');
  for (const warning of warnings) {
    const item = document.createElement('li');
    item.textContent = warning;
    list.append(item);
  }
  details.append(summary, list);
  root.prepend(details);
}

function safeCssLength(value?: string): boolean { return Boolean(value && /^(?:auto|\d+(?:\.\d+)?(?:%|px|em|rem|vw|vh)?)$/i.test(value)); }

function secureLinks(root: HTMLElement): void {
  for (const link of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = link.getAttribute('href') ?? '';
    if (opensExternalPage(href)) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    } else {
      link.removeAttribute('target');
      link.removeAttribute('rel');
    }
  }
}

export function opensExternalPage(href: string): boolean { return /^https?:\/\//i.test(href); }

export function trustedDoiUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'doi.org' && /^\/10\.\d{4,9}\//i.test(url.pathname) ? url.href : undefined;
  } catch { return undefined; }
}

function openTrustedDoi(value?: string): void {
  const url = trustedDoiUrl(value);
  if (!url) return;
  window.open(url, '_blank', 'noopener,noreferrer');
}

function navigatePreviewAnchor(host: HTMLDivElement | null, id: string, blocks: readonly DocumentBlock[], gate: ScrollIntentGate, onNavigate: Props['onNavigate']): void {
  if (!host || !id) return;
  const target = host.shadowRoot?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
  if (!target) return;
  const container = host.parentElement;
  if (container) {
    gate.beginProgrammatic();
    const moved = revealPoint(container, target, undefined, 0);
    if (!moved) gate.endProgrammatic();
    else requestAnimationFrame(() => gate.endProgrammatic());
  }
  const block = target.closest<HTMLElement>('[data-block-id]');
  if (!block?.dataset.blockId) return;
  const sourceBlock = blocks.find((candidate) => candidate.id === block.dataset.blockId);
  const exact = Number(target.dataset.sourceOffset ?? block.dataset.sourceFrom);
  onNavigate(block.dataset.blockId, Number.isFinite(exact) ? exact : sourceBlock?.from);
}

function decodeFragment(value: string): string {
  try { return decodeURIComponent(value); }
  catch { return value; }
}

function blockRemoteResources(root: HTMLElement): void {
  const selector = 'img[src], audio[src], video[src], source[src], track[src], input[src], link[href]';
  for (const element of root.querySelectorAll<HTMLElement>(selector)) {
    const attribute = element.hasAttribute('src') ? 'src' : 'href';
    const value = element.getAttribute(attribute) ?? '';
    if (!/^https?:\/\//i.test(value)) continue;
    if (element instanceof HTMLImageElement) {
      const placeholder = document.createElement('span');
      placeholder.className = 'remote-resource-placeholder';
      placeholder.textContent = element.alt ? `Remote image blocked: ${element.alt}` : 'Remote image blocked';
      element.replaceWith(placeholder);
    } else {
      element.removeAttribute(attribute);
      element.dataset.remoteResourceBlocked = 'true';
    }
  }
}

function highlight(root: HTMLElement, query: string, regularExpression: boolean): void {
  let expression: RegExp;
  try { expression = new RegExp(regularExpression ? query : escapeRegExp(query), 'giu'); }
  catch { return; }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) if (expression.test(walker.currentNode.nodeValue ?? '')) { nodes.push(walker.currentNode as Text); expression.lastIndex = 0; }
  for (const node of nodes) {
    const value = node.nodeValue ?? '';
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    expression.lastIndex = 0;
    for (const match of value.matchAll(expression)) {
      if (!match[0]) continue;
      fragment.append(value.slice(cursor, match.index));
      const mark = document.createElement('mark'); mark.textContent = match[0]; fragment.append(mark);
      cursor = match.index + match[0].length;
    }
    fragment.append(value.slice(cursor));
    node.replaceWith(fragment);
  }
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
