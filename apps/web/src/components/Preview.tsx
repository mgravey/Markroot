import { useEffect, useRef } from 'react';
import DOMPurify from 'dompurify';
import type { ParsedComments } from '@markroot/comments';
import type { SourceRange } from '@markroot/core';
import { documentBlockAt, type DocumentBlock } from '@markroot/document';
import { centeredScrollTop, isScrollKey, ScrollIntentGate, viewportCenter } from './scroll-sync.js';
import { mapRenderedOffset, mapSourceOffset, opensExternalPage, protectLocalObjectUrls, trustedDoiUrl } from './preview-utils.js';
import { applyRenderedTrackChanges, type RenderedReviewChange } from '../rendered-track-changes.js';

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
  trackChangesBaseHtml?: string | undefined;
  activeTrackChange?: Readonly<{ id: string; range: SourceRange; baseText: string }> | undefined;
  reviewChanges?: readonly RenderedReviewChange[] | undefined;
  reviewDecisions?: readonly Readonly<{ id: string; decision: 'pending' | 'accept' | 'reject' }>[] | undefined;
  comments?: ParsedComments | undefined;
  activeCommentId?: string | undefined;
  onNavigate(id: string, sourceOffset?: number): void;
  onSelect(range: SourceRange): void;
  onCommentActivate(id: string): void;
  onScroll(id: string, progress: number): void;
}

export function Preview({ html, objectUrls, warnings, blocks, search, regularExpression, activeBlock, scrollTarget, scrollProgress, scrollAlignment, anchorTarget, allowRemoteResources, fontFamily, fontSize, justified, trackChangesBaseHtml, activeTrackChange, reviewChanges, reviewDecisions, comments, activeCommentId, onNavigate, onSelect, onCommentActivate, onScroll }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const preservedSelection = useRef<Range | undefined>(undefined);
  const preservedSourceSelection = useRef<SourceRange | undefined>(undefined);
  const pointerSelectionStart = useRef<{ offset: number; x: number; y: number; blockId: string } | undefined>(undefined);
  const pendingNavigation = useRef<(() => void) | undefined>(undefined);
  const appliedReviewDecisions = useRef<{ article?: HTMLElement; decisions: Map<string, string> }>({ decisions: new Map() });
  const scrollIntent = useRef(new ScrollIntentGate());
  const latestOnScroll = useRef(onScroll);
  const latestOnNavigate = useRef(onNavigate);
  const latestOnCommentActivate = useRef(onCommentActivate);
  latestOnScroll.current = onScroll;
  latestOnNavigate.current = onNavigate;
  latestOnCommentActivate.current = onCommentActivate;
  useEffect(() => {
    if (!host.current) return;
    const ownerDocument = host.current.ownerDocument;
    const shadow = host.current.shadowRoot ?? host.current.attachShadow({ mode: 'open' });
    const style = ownerDocument.createElement('style');
    style.textContent = previewStyle;
    const article = ownerDocument.createElement('article');
    article.classList.toggle('justified', justified);
    article.innerHTML = DOMPurify.sanitize(protectLocalObjectUrls(html, objectUrls), { FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed'], FORBID_ATTR: ['style'] });
    restoreLocalObjectUrls(article, objectUrls);
    secureLinks(article);
    if (!allowRemoteResources) blockRemoteResources(article);
    prepareFigureImages(article);
    if (trackChangesBaseHtml) {
      const baseArticle = ownerDocument.createElement('article');
      baseArticle.innerHTML = DOMPurify.sanitize(trackChangesBaseHtml, { FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed'], FORBID_ATTR: ['style'] });
      applyRenderedTrackChanges(article, baseArticle);
    }
    appendViewerWarnings(article, warnings);
    if (search) highlight(article, search, regularExpression);
    if (activeBlock) article.querySelector(`[data-block-id="${CSS.escape(activeBlock)}"]`)?.classList.add('active-block');
    if (isHtmlElement(shadow.host)) {
      shadow.host.style.setProperty('--viewer-font', fontStack(fontFamily));
      shadow.host.style.setProperty('--viewer-size', `${fontSize}px`);
    }
    shadow.replaceChildren(style, article);
  }, [html, objectUrls, warnings, search, regularExpression, allowRemoteResources, fontFamily, fontSize, justified, trackChangesBaseHtml, reviewChanges]);
  useEffect(() => {
    const article = host.current?.shadowRoot?.querySelector<HTMLElement>('article');
    if (!article || !reviewDecisions || !reviewChanges) return;
    if (appliedReviewDecisions.current.article !== article) appliedReviewDecisions.current = { article, decisions: new Map() };
    const previous = appliedReviewDecisions.current.decisions;
    const changes = new Map(reviewChanges.map((change) => [change.id, change]));
    const restoreScroll = captureRenderedScrollAnchor(host.current?.parentElement, article, blocks, activeTrackChange);
    let changed = false;
    for (const { id, decision } of reviewDecisions) {
      if (previous.get(id) === decision) continue;
      const change = changes.get(id);
      if (change && decision !== 'pending') {
        applyRenderedReviewDecision(article, blocks, change, decision);
        changed = true;
      }
      previous.set(id, decision);
    }
    if (changed) restoreScroll();
  }, [html, trackChangesBaseHtml, blocks, activeTrackChange, reviewChanges, reviewDecisions]);
  useEffect(() => {
    const article = host.current?.shadowRoot?.querySelector<HTMLElement>('article');
    if (article) updateRenderedActiveChange(article, blocks, activeTrackChange);
  }, [html, trackChangesBaseHtml, blocks, activeTrackChange]);
  useEffect(() => {
    const shadow = host.current?.shadowRoot;
    shadow?.querySelectorAll('.active-block').forEach((element) => element.classList.remove('active-block'));
    if (activeBlock) shadow?.querySelector(`[data-block-id="${CSS.escape(activeBlock)}"]`)?.classList.add('active-block');
  }, [activeBlock, html]);
  useEffect(() => {
    const hostElement = host.current;
    const shadow = hostElement?.shadowRoot;
    if (!hostElement || !shadow) return;
    const draw = () => drawCommentGutter(shadow, comments, blocks, activeCommentId, (id) => latestOnCommentActivate.current(id));
    draw();
    const eventWindow = hostElement.ownerDocument.defaultView;
    const ResizeObserverClass = eventWindow?.ResizeObserver;
    let width = hostElement.clientWidth;
    const observer = ResizeObserverClass ? new ResizeObserverClass(() => {
      const nextWidth = hostElement.clientWidth;
      if (Math.abs(nextWidth - width) < 1) return;
      width = nextWidth;
      draw();
    }) : undefined;
    observer?.observe(hostElement);
    let cancelled = false;
    void hostElement.ownerDocument.fonts?.ready.then(() => { if (!cancelled) draw(); });
    return () => { cancelled = true; observer?.disconnect(); };
  }, [html, comments, blocks, activeCommentId, fontFamily, fontSize, justified, trackChangesBaseHtml]);
  useEffect(() => {
    const target = scrollTarget ? host.current?.shadowRoot?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(scrollTarget)}"]`) : undefined;
    if (target) {
      const container = host.current?.parentElement;
      const next = isHtmlElement(target.nextElementSibling) ? target.nextElementSibling : undefined;
      const eventWindow = target.ownerDocument.defaultView ?? window;
      scrollIntent.current.beginProgrammatic();
      const moved = container ? (scrollAlignment === 'center' ? centerPoint : revealPoint)(container, target, next, scrollProgress ?? 0) : (target.scrollIntoView({ block: 'center' }), true);
      if (!moved) scrollIntent.current.endProgrammatic();
      else eventWindow.requestAnimationFrame(() => scrollIntent.current.endProgrammatic());
    }
  }, [scrollTarget, scrollProgress, scrollAlignment, html, trackChangesBaseHtml]);
  useEffect(() => {
    if (anchorTarget) navigatePreviewAnchor(host.current, anchorTarget.id, blocks, scrollIntent.current, latestOnNavigate.current);
  }, [anchorTarget, blocks, html]);
  useEffect(() => {
    const container = host.current?.parentElement;
    if (!container) return;
    const eventWindow = container.ownerDocument.defaultView ?? window;
    let frame = 0;
    const handle = () => {
      if (!scrollIntent.current.shouldPublish()) return;
      scrollIntent.current.continueScroll();
      eventWindow.cancelAnimationFrame(frame);
      frame = eventWindow.requestAnimationFrame(() => {
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
    eventWindow.addEventListener('pointerup', endPointer, { passive: true });
    eventWindow.addEventListener('pointercancel', endPointer, { passive: true });
    return () => {
      eventWindow.cancelAnimationFrame(frame);
      container.removeEventListener('scroll', handle);
      container.removeEventListener('wheel', markWheel);
      container.removeEventListener('pointerdown', beginPointer);
      container.removeEventListener('keydown', markKeyboard);
      eventWindow.removeEventListener('pointerup', endPointer);
      eventWindow.removeEventListener('pointercancel', endPointer);
    };
  }, [html]);
  const cancelPendingNavigation = () => {
    pendingNavigation.current?.();
    pendingNavigation.current = undefined;
  };
  const finalizeRenderedSelection = () => {
    const domRange = renderedSelectionRange(host.current) ?? preservedSelection.current;
    const selectedText = host.current?.ownerDocument.defaultView?.getSelection()?.toString() ?? '';
    const sourceRange = (domRange ? renderedSourceRange(host.current, blocks, domRange) : undefined)
      ?? preservedSourceSelection.current
      ?? sourceRangeAroundPointer(blocks, pointerSelectionStart.current, selectedText);
    if (!sourceRange) return false;
    cancelPendingNavigation();
    preservedSourceSelection.current = sourceRange;
    if (domRange) preservedSelection.current = domRange.cloneRange();
    if (host.current?.shadowRoot) drawPreservedSelection(host.current.shadowRoot, blocks, sourceRange);
    onSelect(sourceRange);
    if (domRange) host.current?.ownerDocument.defaultView?.requestAnimationFrame(() => restoreRenderedSelection(host.current, preservedSelection.current));
    return true;
  };
  const finishSelectionAfterBrowserDefault = () => {
    const eventWindow = host.current?.ownerDocument.defaultView;
    eventWindow?.setTimeout(() => { finalizeRenderedSelection(); }, 0);
  };
  return <div className={`preview${comments?.threads.length ? ' has-comments' : ''}`} ref={host} onPointerDown={(event) => {
    cancelPendingNavigation();
    preservedSelection.current = undefined;
    preservedSourceSelection.current = undefined;
    pointerSelectionStart.current = sourcePointFromEvent(host.current, blocks, event.nativeEvent.composedPath(), event.clientX, event.clientY);
    host.current?.shadowRoot?.querySelector('.preserved-selection-layer')?.remove();
  }} onPointerUp={(event) => {
    const capturedRange = renderedSelectionRange(host.current)?.cloneRange();
    if (capturedRange) preservedSelection.current = capturedRange;
    const start = pointerSelectionStart.current;
    const end = sourcePointFromEvent(host.current, blocks, event.nativeEvent.composedPath(), event.clientX, event.clientY);
    if (start && end && start.offset !== end.offset && Math.hypot(event.clientX - start.x, event.clientY - start.y) >= 3) {
      preservedSourceSelection.current = { from: Math.min(start.offset, end.offset), to: Math.max(start.offset, end.offset) };
    }
    finishSelectionAfterBrowserDefault();
  }} onClick={(event) => {
    const selectedRange = renderedSelectionRange(host.current) ?? preservedSelection.current;
    if (preservedSourceSelection.current || (selectedRange && renderedSourceRange(host.current, blocks, selectedRange))) {
      event.preventDefault();
      finishSelectionAfterBrowserDefault();
      return;
    }
    const path = event.nativeEvent.composedPath();
    const doiLink = path.find((item): item is HTMLElement => isHtmlElement(item) && item.hasAttribute('data-doi-url'));
    if (doiLink && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      openTrustedDoi(doiLink.dataset.doiUrl, doiLink.ownerDocument.defaultView ?? window);
      return;
    }
    const link = path.find((item): item is HTMLAnchorElement => isHtmlElement(item) && item.tagName === 'A') as HTMLAnchorElement | undefined;
    const href = link?.getAttribute('href') ?? '';
    if (href.startsWith('#')) {
      event.preventDefault();
      navigatePreviewAnchor(host.current, decodeFragment(href.slice(1)), blocks, scrollIntent.current, onNavigate);
      return;
    }
    if (link) return;
    const block = path.find((item): item is HTMLElement => isHtmlElement(item) && item.hasAttribute('data-block-id'));
    if (!block?.dataset.blockId) return;
    if (event.detail > 1) {
      event.preventDefault();
      finishSelectionAfterBrowserDefault();
      return;
    }
    const mapped = path.find((item): item is HTMLElement => isHtmlElement(item) && item.hasAttribute('data-source-offset'));
    const exact = mapped?.dataset.sourceOffset ? Number(mapped.dataset.sourceOffset) : undefined;
    const sourceBlock = blocks.find((candidate) => candidate.id === block.dataset.blockId);
    const sourceOffset = Number.isFinite(exact) ? exact : sourceBlock ? sourceOffsetAtPoint(host.current?.shadowRoot, block, sourceBlock, event.clientX, event.clientY) : undefined;
    const blockId = block.dataset.blockId;
    const eventWindow = block.ownerDocument.defaultView ?? window;
    const timer = eventWindow.setTimeout(() => {
      pendingNavigation.current = undefined;
      if (finalizeRenderedSelection()) return;
      onNavigate(blockId, sourceOffset);
    }, 400);
    pendingNavigation.current = () => eventWindow.clearTimeout(timer);
  }} onDoubleClick={(event) => {
    event.preventDefault();
    finishSelectionAfterBrowserDefault();
  }} />;
}

const previewStyle = `
  :host { color: var(--ink); }
  article { position: relative; min-height: 100%; overflow-anchor: none; font-family: var(--viewer-font); font-size: var(--viewer-size); line-height: 1.72; }
  .comment-gutter { position: absolute; inset: 0 0 auto 0; pointer-events: none; font-family: 'Manrope', sans-serif; font-size: max(11px, .68em); line-height: 1.4; }
  .preserved-selection-layer { position: absolute; inset: 0 0 auto 0; pointer-events: none; }
  .preserved-selection-highlight { position: absolute; z-index: 1; border-radius: .18em; background: color-mix(in srgb, var(--accent) 22%, transparent); box-shadow: inset 0 -.12em 0 color-mix(in srgb, var(--accent) 62%, transparent); }
  .comment-highlight { position: absolute; z-index: 1; border-radius: .18em; background: color-mix(in srgb, var(--accent) 13%, transparent); box-shadow: inset 0 -.1em 0 color-mix(in srgb, var(--accent) 48%, transparent); transition: background-color 120ms ease, box-shadow 120ms ease; }
  .comment-highlight.active, .comment-highlight.hovered { background: color-mix(in srgb, var(--accent) 30%, transparent); box-shadow: inset 0 -.14em 0 var(--accent); }
  .comment-card { position: absolute; z-index: 2; left: calc(100% + .65em); width: min(11em, 34%); padding: .7em .75em; pointer-events: auto; color: var(--ink); background: color-mix(in srgb, var(--surface-strong) 96%, transparent); border: max(1px, .07em) solid var(--line); border-left: .22em solid var(--accent); border-radius: .45em; box-shadow: 0 .3em 1.1em color-mix(in srgb, #000 12%, transparent); text-align: left; cursor: pointer; transition: border-color 120ms ease, box-shadow 120ms ease, transform 120ms ease; }
  .comment-card:hover, .comment-card.active { border-color: var(--accent); box-shadow: 0 .4em 1.25em color-mix(in srgb, #000 17%, transparent); transform: translateX(-.12em); }
  .comment-card.resolved { opacity: .62; border-left-color: var(--muted); }
  .comment-card strong, .comment-card span { display: block; overflow: hidden; text-overflow: ellipsis; }
  .comment-card strong { margin-bottom: .28em; font-size: .95em; white-space: nowrap; }
  .comment-card span { display: -webkit-box; color: var(--muted); -webkit-box-orient: vertical; -webkit-line-clamp: 3; }
  .comment-card small { display: block; margin-top: .4em; color: var(--accent-strong); font-size: .78em; }
  article.justified p, article.justified li, article.justified blockquote { text-align: justify; text-justify: inter-word; hyphens: auto; }
  h1, h2, h3 { line-height: 1.18; letter-spacing: -.02em; }
  h1 { margin-top: .6em; font-size: 2.25em; }
  h2 { margin-top: 1.6em; font-size: 1.55em; }
  h3 { margin-top: 1.45em; font-size: 1.2em; }
  a { color: var(--accent-strong); }
  [data-block-id] { position: relative; margin-inline: -.706em; padding-inline: .706em; border-radius: .294em; scroll-margin-block: 40vh; transition: background-color 120ms ease, box-shadow 120ms ease; }
  [data-block-id].active-block { background: color-mix(in srgb, var(--accent) 9%, transparent); box-shadow: -.176em 0 0 var(--accent); }
  pre { overflow: auto; padding: .824em; color: #d5e7e2; background: #111a18; border-radius: .412em; }
  code { font-family: 'IBM Plex Mono', monospace; font-size: .86em; }
  :not(pre) > code { padding: .12em .34em; color: var(--accent-strong); background: var(--accent-soft); border-radius: .205em; }
  figure { margin: 1.7em auto; text-align: center; }
  figure img { display: block; max-width: 100%; height: auto; margin: auto; border-radius: .235em; }
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
  .image-missing { display: grid; place-items: center; min-height: 8.824em; padding: 1.294em; color: var(--muted); background: color-mix(in srgb, var(--surface-strong) 76%, transparent); border: max(1px, .059em) dashed var(--line-strong); border-radius: .353em; font-family: 'Manrope', sans-serif; text-align: center; }
  .image-missing strong { color: var(--ink); font-size: .86em; }
  .image-missing code { max-width: 100%; margin-top: .4em; overflow-wrap: anywhere; color: var(--muted); background: transparent; }
  .viewer-warnings { margin: 0 0 1.3em; padding: .65em .8em; color: var(--muted); background: var(--surface-strong); border: max(1px, .077em) solid var(--line); border-radius: .464em; font: .76em/1.45 'Manrope', sans-serif; }
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
  mark { color: inherit; background: #ffd76a; border-radius: .118em; }
  ins.render-track-insert { color: var(--accent-strong); background: var(--accent-soft); text-decoration: underline; text-decoration-color: var(--accent); text-underline-offset: .12em; border-radius: .12em; }
  del.render-track-delete { margin-inline: .06em; padding-inline: .08em; color: var(--danger); background: var(--danger-soft); text-decoration: line-through; text-decoration-thickness: .09em; border-radius: .12em; white-space: pre-wrap; }
  ins.render-track-insert[data-review-decision="accept"] { color: inherit; background: transparent; text-decoration: none; }
  del.render-track-delete[data-review-decision="accept"] { display: none; }
  ins.render-track-insert[data-review-decision="reject"] { display: none; }
  del.render-track-delete[data-review-decision="reject"] { margin-inline: 0; padding-inline: 0; color: inherit; background: transparent; text-decoration: none; }
  .render-review-active { font-weight: 700; }
  .remote-resource-placeholder { display: block; padding: 1.333em; color: var(--muted); background: var(--surface-strong); border: max(1px, .083em) dashed var(--line-strong); border-radius: .5em; font-family: 'Manrope', sans-serif; font-size: .706em; text-align: center; }
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
  const ownerDocument = blockElement.ownerDocument;
  const documentWithCaret = ownerDocument as Document & {
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
  const range = ownerDocument.createRange();
  range.selectNodeContents(blockElement);
  try { range.setEnd(node, offset); }
  catch { return block.from; }
  return block.from + mapRenderedOffset(block.text, blockElement.textContent ?? '', range.toString().length);
}

function sourcePointFromEvent(host: HTMLDivElement | null, blocks: readonly DocumentBlock[], path: readonly EventTarget[], x: number, y: number): { offset: number; x: number; y: number; blockId: string } | undefined {
  const blockElement = path.find((item): item is HTMLElement => isHtmlElement(item) && item.hasAttribute('data-block-id'));
  const block = blocks.find((candidate) => candidate.id === blockElement?.dataset.blockId);
  if (!host?.shadowRoot || !blockElement || !block) return undefined;
  return { offset: sourceOffsetAtPoint(host.shadowRoot, blockElement, block, x, y), x, y, blockId: block.id };
}

function sourceRangeAroundPointer(blocks: readonly DocumentBlock[], pointer: { offset: number; blockId: string } | undefined, selectedText: string): SourceRange | undefined {
  const needle = selectedText.trim();
  const block = blocks.find((candidate) => candidate.id === pointer?.blockId);
  if (!pointer || !block || !needle) return undefined;
  const source = block.text.toLocaleLowerCase();
  const target = needle.toLocaleLowerCase();
  const candidates: number[] = [];
  let index = source.indexOf(target);
  while (index >= 0) {
    candidates.push(index);
    index = source.indexOf(target, index + Math.max(1, target.length));
  }
  if (!candidates.length) return undefined;
  const localPointer = pointer.offset - block.from;
  const start = candidates.reduce((nearest, candidate) => {
    const distance = localPointer < candidate ? candidate - localPointer : localPointer > candidate + target.length ? localPointer - candidate - target.length : 0;
    const nearestDistance = localPointer < nearest ? nearest - localPointer : localPointer > nearest + target.length ? localPointer - nearest - target.length : 0;
    return distance < nearestDistance ? candidate : nearest;
  });
  return { from: block.from + start, to: block.from + start + needle.length };
}

function renderedSelectionRange(host: HTMLDivElement | null): Range | undefined {
  const shadow = host?.shadowRoot;
  const selection = host?.ownerDocument.defaultView?.getSelection();
  if (!shadow || !selection || selection.isCollapsed || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  if (!shadow.contains(range.startContainer) || !shadow.contains(range.endContainer)) return undefined;
  return range;
}

function renderedSourceRange(host: HTMLDivElement | null, blocks: readonly DocumentBlock[], range = renderedSelectionRange(host)): SourceRange | undefined {
  const shadow = host?.shadowRoot;
  if (!shadow || !range || !shadow.contains(range.startContainer) || !shadow.contains(range.endContainer)) return undefined;
  const startElement = elementForNode(range.startContainer);
  const endElement = elementForNode(range.endContainer);
  const startBlockElement = startElement?.closest<HTMLElement>('[data-block-id]');
  const endBlockElement = endElement?.closest<HTMLElement>('[data-block-id]');
  const startBlock = blocks.find((block) => block.id === startBlockElement?.dataset.blockId);
  const endBlock = blocks.find((block) => block.id === endBlockElement?.dataset.blockId);
  if (!startBlockElement || !endBlockElement || !startBlock || !endBlock) return undefined;
  const from = sourceOffsetAtDomPosition(startBlockElement, startBlock, range.startContainer, range.startOffset);
  const to = sourceOffsetAtDomPosition(endBlockElement, endBlock, range.endContainer, range.endOffset);
  const normalized = { from: Math.min(from, to), to: Math.max(from, to) };
  return normalized.to > normalized.from ? normalized : undefined;
}

function restoreRenderedSelection(host: HTMLDivElement | null, range: Range | undefined): void {
  if (!host?.shadowRoot || !range || !range.startContainer.isConnected || !range.endContainer.isConnected) return;
  if (!host.shadowRoot.contains(range.startContainer) || !host.shadowRoot.contains(range.endContainer)) return;
  const selection = host.ownerDocument.defaultView?.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
}

function drawPreservedSelection(shadow: ShadowRoot, blocks: readonly DocumentBlock[], sourceRange: SourceRange): void {
  shadow.querySelector('.preserved-selection-layer')?.remove();
  const article = shadow.querySelector<HTMLElement>('article');
  if (!article) return;
  const articleRect = article.getBoundingClientRect();
  const layer = article.ownerDocument.createElement('span');
  layer.className = 'preserved-selection-layer';
  layer.setAttribute('aria-hidden', 'true');
  const rectangles = renderedDomRanges(shadow, blocks, sourceRange)
    .flatMap((range) => [...range.getClientRects()])
    .filter((rectangle) => rectangle.width > 0 && rectangle.height > 0);
  for (const rectangle of rectangles) {
    const highlight = article.ownerDocument.createElement('span');
    highlight.className = 'preserved-selection-highlight';
    highlight.style.left = `${rectangle.left - articleRect.left}px`;
    highlight.style.top = `${rectangle.top - articleRect.top}px`;
    highlight.style.width = `${rectangle.width}px`;
    highlight.style.height = `${rectangle.height}px`;
    layer.append(highlight);
  }
  if (layer.childElementCount) article.append(layer);
}

function sourceOffsetAtDomPosition(blockElement: HTMLElement, block: DocumentBlock, node: Node, offset: number): number {
  const range = blockElement.ownerDocument.createRange();
  range.selectNodeContents(blockElement);
  try { range.setEnd(node, offset); }
  catch { return block.from; }
  return block.from + mapRenderedOffset(block.text, blockElement.textContent ?? '', range.toString().length);
}

function elementForNode(node: Node): Element | null {
  return node.nodeType === 1 ? node as Element : node.parentElement;
}

function nearestTextCaret(root: HTMLElement, x: number, y: number): { node: Text; offset: number } | undefined {
  const ownerDocument = root.ownerDocument;
  const showText = ownerDocument.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const walker = ownerDocument.createTreeWalker(root, showText);
  let best: { node: Text; offset: number; distance: number } | undefined;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.length || !node.nodeValue?.trim()) continue;
    const stride = Math.max(1, Math.ceil(node.length / 1024));
    for (let offset = 0; offset <= node.length; offset += stride) {
      const range = ownerDocument.createRange();
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
    const range = ownerDocument.createRange();
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

function drawCommentGutter(shadow: ShadowRoot, comments: ParsedComments | undefined, blocks: readonly DocumentBlock[], activeCommentId: string | undefined, onActivate: (id: string) => void): void {
  shadow.querySelector('.comment-gutter')?.remove();
  const article = shadow.querySelector<HTMLElement>('article');
  if (!article) return;
  article.style.removeProperty('min-height');
  if (!comments?.threads.length) return;
  const baseHeight = article.scrollHeight;
  const articleRect = article.getBoundingClientRect();
  const gutter = article.ownerDocument.createElement('aside');
  gutter.className = 'comment-gutter';
  gutter.setAttribute('aria-label', 'Document comments');
  const placements: Array<{ card: HTMLButtonElement; anchorTop: number }> = [];

  for (const thread of comments.threads) {
    const sourceRange = comments.ranges.get(thread.id);
    if (!sourceRange) continue;
    const domRanges = renderedDomRanges(shadow, blocks, sourceRange);
    if (!domRanges.length) continue;
    const rectangles = domRanges.flatMap((range) => [...range.getClientRects()]).filter((rect) => rect.width > 0 && rect.height > 0);
    if (!rectangles.length) continue;
    for (const rectangle of rectangles) {
      const highlight = article.ownerDocument.createElement('span');
      highlight.className = `comment-highlight${thread.id === activeCommentId ? ' active' : ''}`;
      highlight.dataset.commentId = thread.id;
      highlight.style.left = `${rectangle.left - articleRect.left}px`;
      highlight.style.top = `${rectangle.top - articleRect.top}px`;
      highlight.style.width = `${rectangle.width}px`;
      highlight.style.height = `${rectangle.height}px`;
      gutter.append(highlight);
    }
    const latest = thread.messages.at(-1);
    const card = article.ownerDocument.createElement('button');
    card.type = 'button';
    card.className = `comment-card${thread.status === 'resolved' ? ' resolved' : ''}${thread.id === activeCommentId ? ' active' : ''}`;
    card.dataset.commentId = thread.id;
    card.setAttribute('aria-label', `Open comment by ${latest?.author.displayName ?? 'Unknown author'}`);
    const author = article.ownerDocument.createElement('strong');
    author.textContent = latest?.author.displayName ?? 'Unknown author';
    const body = article.ownerDocument.createElement('span');
    body.textContent = latest?.body ?? '';
    card.append(author, body);
    if (thread.messages.length > 1) {
      const replies = article.ownerDocument.createElement('small');
      replies.textContent = `${thread.messages.length - 1} ${thread.messages.length === 2 ? 'reply' : 'replies'}`;
      card.append(replies);
    }
    const toggleHover = (hovered: boolean) => {
      for (const highlight of gutter.querySelectorAll<HTMLElement>('.comment-highlight')) {
        if (highlight.dataset.commentId === thread.id) highlight.classList.toggle('hovered', hovered);
      }
    };
    card.addEventListener('mouseenter', () => toggleHover(true));
    card.addEventListener('mouseleave', () => toggleHover(false));
    card.addEventListener('click', (event) => { event.stopPropagation(); onActivate(thread.id); });
    gutter.append(card);
    placements.push({ card, anchorTop: Math.max(0, rectangles[0]!.top - articleRect.top) });
  }

  if (!placements.length) {
    return;
  }
  article.append(gutter);
  let nextTop = 0;
  for (const placement of placements.sort((left, right) => left.anchorTop - right.anchorTop)) {
    const top = Math.max(placement.anchorTop, nextTop);
    placement.card.style.top = `${top}px`;
    nextTop = top + placement.card.offsetHeight + 8;
  }
  article.style.minHeight = `${Math.max(baseHeight, nextTop)}px`;
}

function markRenderedSourceRange(root: ParentNode, blocks: readonly DocumentBlock[], sourceRange: SourceRange): void {
  for (const range of renderedDomRanges(root, blocks, sourceRange)) {
    const container = elementForNode(range.commonAncestorContainer);
    if (!container) continue;
    const ownerDocument = container.ownerDocument;
    const showText = ownerDocument.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
    const walker = ownerDocument.createTreeWalker(container, showText);
    const portions: Array<{ node: Text; from: number; to: number }> = [];
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (!node.length || !range.intersectsNode(node)) continue;
      const from = node === range.startContainer ? range.startOffset : 0;
      const to = node === range.endContainer ? range.endOffset : node.length;
      if (from < to) portions.push({ node, from, to });
    }
    for (const { node, from, to } of portions) {
      const fragment = ownerDocument.createDocumentFragment();
      if (from > 0) fragment.append(node.data.slice(0, from));
      const strong = ownerDocument.createElement('strong');
      strong.className = 'render-review-active';
      strong.textContent = node.data.slice(from, to);
      fragment.append(strong);
      if (to < node.length) fragment.append(node.data.slice(to));
      node.replaceWith(fragment);
    }
  }
}

function updateRenderedActiveChange(article: HTMLElement, blocks: readonly DocumentBlock[], active: Props['activeTrackChange']): void {
  const wrappers = article.querySelectorAll<HTMLElement>('strong.render-review-active');
  for (const wrapper of wrappers) wrapper.replaceWith(...wrapper.childNodes);
  if (wrappers.length) article.normalize();
  article.querySelectorAll('.render-review-active').forEach((element) => element.classList.remove('render-review-active'));
  if (!active) return;
  if (active.range.from < active.range.to) {
    markRenderedSourceRange(article, blocks, active.range);
    return;
  }
  const block = documentBlockAt(blocks, active.range.from);
  const blockElement = block ? article.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(block.id)}"]`) : undefined;
  if (!block || !blockElement) return;
  const normalizedBase = normalizeReviewText(active.baseText);
  const candidates = [...blockElement.querySelectorAll<HTMLElement>('del.render-track-delete')]
    .filter((element) => normalizedBase.includes(normalizeReviewText(element.textContent ?? '')));
  for (const deletion of nearestRenderedDeletions(blockElement, block, active.range.from, candidates)) {
    deletion.classList.add('render-review-active');
  }
}

function captureRenderedScrollAnchor(container: HTMLElement | null | undefined, article: HTMLElement, blocks: readonly DocumentBlock[], active: Props['activeTrackChange']): () => void {
  if (!container) return () => undefined;
  let anchor: Range | HTMLElement | undefined;
  if (active?.range.from !== undefined && active.range.from < active.range.to) {
    anchor = renderedDomRanges(article, blocks, active.range)[0];
  } else if (active) {
    const block = documentBlockAt(blocks, active.range.from);
    const blockElement = block ? article.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(block.id)}"]`) : undefined;
    const normalizedBase = normalizeReviewText(active.baseText);
    const candidates = [...(blockElement?.querySelectorAll<HTMLElement>('del.render-track-delete') ?? [])]
      .filter((element) => normalizedBase.includes(normalizeReviewText(element.textContent ?? '')));
    anchor = block && blockElement ? nearestRenderedDeletions(blockElement, block, active.range.from, candidates)[0] : undefined;
  }
  if (!anchor) {
    const viewport = container.getBoundingClientRect();
    anchor = [...article.querySelectorAll<HTMLElement>('[data-block-id]')]
      .find((element) => element.getBoundingClientRect().bottom >= viewport.top);
  }
  if (!anchor) return () => undefined;
  const scrollTop = container.scrollTop;
  const top = anchor.getBoundingClientRect().top;
  return () => {
    const nextTop = anchor?.getBoundingClientRect().top;
    if (nextTop === undefined || !Number.isFinite(nextTop) || !Number.isFinite(top)) return;
    container.scrollTop = scrollTop + nextTop - top;
  };
}

function applyRenderedReviewDecision(article: HTMLElement, blocks: readonly DocumentBlock[], change: RenderedReviewChange, decision: 'accept' | 'reject'): void {
  const domRanges = change.compareRange.from < change.compareRange.to ? renderedDomRanges(article, blocks, change.compareRange) : [];
  const affected = new Set<HTMLElement>();
  if (change.compareText) {
    for (const element of article.querySelectorAll<HTMLElement>('ins.render-track-insert')) {
      if (domRanges.some((range) => safelyIntersects(range, element))) affected.add(element);
    }
  }
  const candidateBlocks = change.compareRange.from === change.compareRange.to
    ? [documentBlockAt(blocks, change.compareRange.from)].filter((block): block is DocumentBlock => Boolean(block))
    : blocks.filter((block) => change.compareRange.to > block.from && change.compareRange.from < block.to);
  if (!change.baseText) {
    for (const element of affected) {
      element.dataset.reviewChangeId = change.id;
      element.dataset.reviewDecision = decision;
    }
    return;
  }
  const normalizedBase = normalizeReviewText(change.baseText);
  for (const block of candidateBlocks) {
    const blockElement = article.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(block.id)}"]`);
    if (!blockElement) continue;
    const deletions = [...blockElement.querySelectorAll<HTMLElement>('del.render-track-delete')];
    const matching = normalizedBase
      ? deletions.filter((element) => {
        const value = normalizeReviewText(element.textContent ?? '');
        return value && (normalizedBase.includes(value) || value.includes(normalizedBase));
      })
      : deletions;
    for (const deletion of nearestRenderedDeletions(blockElement, block, change.compareRange.from, matching)) affected.add(deletion);
  }
  for (const element of affected) {
    element.dataset.reviewChangeId = change.id;
    element.dataset.reviewDecision = decision;
  }
}

function safelyIntersects(range: Range, element: HTMLElement): boolean {
  try { return range.intersectsNode(element); }
  catch { return false; }
}

function nearestRenderedDeletions(blockElement: HTMLElement, block: DocumentBlock, sourceOffset: number, candidates: readonly HTMLElement[]): HTMLElement[] {
  if (!candidates.length) return [];
  const rendered = currentRenderedText(blockElement);
  const target = mapSourceOffset(block.text, rendered, Math.max(0, Math.min(block.text.length, sourceOffset - block.from)));
  let shortestDistance = Number.POSITIVE_INFINITY;
  const nearest: HTMLElement[] = [];
  for (const element of candidates) {
    const offset = visibleTextOffsetBefore(blockElement, element);
    const distance = Math.abs(offset - target);
    if (distance < shortestDistance) {
      shortestDistance = distance;
      nearest.splice(0, nearest.length, element);
    } else if (distance === shortestDistance) {
      nearest.push(element);
    }
  }
  return nearest;
}

function visibleTextOffsetBefore(root: HTMLElement, target: HTMLElement): number {
  const showText = root.ownerDocument.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const walker = root.ownerDocument.createTreeWalker(root, showText);
  let offset = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (target.contains(node)) return offset;
    if (!node.parentElement?.closest('del.render-track-delete')) offset += node.length;
  }
  return offset;
}

function normalizeReviewText(value: string): string { return value.replace(/[^\p{L}\p{N}]+/gu, '').toLocaleLowerCase(); }

function renderedDomRanges(root: ParentNode, blocks: readonly DocumentBlock[], sourceRange: SourceRange): Range[] {
  const ranges: Range[] = [];
  for (const block of blocks) {
    if (sourceRange.to <= block.from || sourceRange.from >= block.to) continue;
    const element = root.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(block.id)}"]`);
    if (!element) continue;
    const rendered = currentRenderedText(element);
    if (!rendered) continue;
    const from = mapSourceOffset(block.text, rendered, Math.max(0, sourceRange.from - block.from));
    const to = mapSourceOffset(block.text, rendered, Math.min(block.text.length, sourceRange.to - block.from));
    const start = textPositionAt(element, Math.min(from, to), true);
    const end = textPositionAt(element, Math.max(from, to), true);
    if (!start || !end || from === to) continue;
    const range = element.ownerDocument.createRange();
    try {
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      ranges.push(range);
    } catch { /* Skip a stale layout range. */ }
  }
  return ranges;
}

function currentRenderedText(root: HTMLElement): string {
  const ownerDocument = root.ownerDocument;
  const showText = ownerDocument.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const walker = ownerDocument.createTreeWalker(root, showText);
  let value = '';
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.parentElement?.closest('del.render-track-delete')) value += node.data;
  }
  return value;
}

function textPositionAt(root: HTMLElement, targetOffset: number, ignoreDeleted = false): { node: Text; offset: number } | undefined {
  const ownerDocument = root.ownerDocument;
  const showText = ownerDocument.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const walker = ownerDocument.createTreeWalker(root, showText);
  let consumed = 0;
  let last: Text | undefined;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (ignoreDeleted && node.parentElement?.closest('del.render-track-delete')) continue;
    last = node;
    if (targetOffset <= consumed + node.length) return { node, offset: Math.max(0, targetOffset - consumed) };
    consumed += node.length;
  }
  return last ? { node: last, offset: last.length } : undefined;
}

function fontStack(font: Props['fontFamily']): string {
  if (font === 'mono') return `'IBM Plex Mono', 'SFMono-Regular', Consolas, monospace`;
  if (font === 'sans') return `'Manrope', system-ui, sans-serif`;
  return `'Source Serif 4', Georgia, serif`;
}

function prepareFigureImages(root: HTMLElement): void {
  const ownerDocument = root.ownerDocument;
  for (const image of root.querySelectorAll<HTMLImageElement>('img')) {
    const width = image.dataset.figureWidth;
    const height = image.dataset.figureHeight;
    if (safeCssLength(width)) image.style.width = width!;
    if (safeCssLength(height)) image.style.height = height!;
    image.addEventListener('error', () => {
      const source = image.dataset.imageSource ?? image.getAttribute('src') ?? image.alt;
      const placeholder = ownerDocument.createElement('span');
      placeholder.className = 'image-missing';
      placeholder.setAttribute('role', 'img');
      placeholder.setAttribute('aria-label', `Image unavailable: ${image.alt || source}`);
      const heading = ownerDocument.createElement('strong');
      heading.textContent = 'Image unavailable';
      const code = ownerDocument.createElement('code');
      code.textContent = source;
      placeholder.append(heading, code);
      image.replaceWith(placeholder);
    }, { once: true });
  }
}

function restoreLocalObjectUrls(root: HTMLElement, objectUrls: readonly string[]): void {
  for (const element of root.querySelectorAll<HTMLElement>('[data-markroot-object-url]')) {
    const index = Number.parseInt(element.dataset.markrootObjectUrl ?? '', 10);
    element.removeAttribute('data-markroot-object-url');
    if (element.tagName !== 'IMG' || !Number.isInteger(index) || index < 0 || index >= objectUrls.length) continue;
    (element as HTMLImageElement).src = objectUrls[index]!;
  }
}

function appendViewerWarnings(root: HTMLElement, warnings: readonly string[]): void {
  if (!warnings.length) return;
  const ownerDocument = root.ownerDocument;
  const details = ownerDocument.createElement('details');
  details.className = 'viewer-warnings';
  const summary = ownerDocument.createElement('summary');
  summary.textContent = `${warnings.length} viewer ${warnings.length === 1 ? 'note' : 'notes'}`;
  const list = ownerDocument.createElement('ul');
  for (const warning of warnings) {
    const item = ownerDocument.createElement('li');
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

function openTrustedDoi(value: string | undefined, targetWindow: Window): void {
  const url = trustedDoiUrl(value);
  if (!url) return;
  targetWindow.open(url, '_blank', 'noopener,noreferrer');
}

function navigatePreviewAnchor(host: HTMLDivElement | null, id: string, blocks: readonly DocumentBlock[], gate: ScrollIntentGate, onNavigate: Props['onNavigate']): void {
  if (!host || !id) return;
  const target = host.shadowRoot?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
  if (!target) return;
  const container = host.parentElement;
  if (container) {
    const eventWindow = container.ownerDocument.defaultView ?? window;
    gate.beginProgrammatic();
    const moved = revealPoint(container, target, undefined, 0);
    if (!moved) gate.endProgrammatic();
    else eventWindow.requestAnimationFrame(() => gate.endProgrammatic());
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
  const ownerDocument = root.ownerDocument;
  const selector = 'img[src], audio[src], video[src], source[src], track[src], input[src], link[href]';
  for (const element of root.querySelectorAll<HTMLElement>(selector)) {
    const attribute = element.hasAttribute('src') ? 'src' : 'href';
    const value = element.getAttribute(attribute) ?? '';
    if (!/^https?:\/\//i.test(value)) continue;
    if (element.tagName === 'IMG') {
      const placeholder = ownerDocument.createElement('span');
      placeholder.className = 'remote-resource-placeholder';
      const image = element as HTMLImageElement;
      placeholder.textContent = image.alt ? `Remote image blocked: ${image.alt}` : 'Remote image blocked';
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
  const ownerDocument = root.ownerDocument;
  const showText = ownerDocument.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const walker = ownerDocument.createTreeWalker(root, showText);
  const nodes: Text[] = [];
  while (walker.nextNode()) if (expression.test(walker.currentNode.nodeValue ?? '')) { nodes.push(walker.currentNode as Text); expression.lastIndex = 0; }
  for (const node of nodes) {
    const value = node.nodeValue ?? '';
    const fragment = ownerDocument.createDocumentFragment();
    let cursor = 0;
    expression.lastIndex = 0;
    for (const match of value.matchAll(expression)) {
      if (!match[0]) continue;
      fragment.append(value.slice(cursor, match.index));
      const mark = ownerDocument.createElement('mark'); mark.textContent = match[0]; fragment.append(mark);
      cursor = match.index + match[0].length;
    }
    fragment.append(value.slice(cursor));
    node.replaceWith(fragment);
  }
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function isHtmlElement(value: unknown): value is HTMLElement {
  return typeof value === 'object' && value !== null && 'nodeType' in value && (value as Node).nodeType === 1 && 'hasAttribute' in value;
}
