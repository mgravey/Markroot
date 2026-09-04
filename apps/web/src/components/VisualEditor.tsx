import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import { defaultMarkdownParser, defaultMarkdownSerializer } from 'prosemirror-markdown';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { DocumentBlock, DocumentSnapshot } from '@markroot/document';
import { maskMarkdownHtmlComments } from '@markroot/rendering';
import { centeredScrollTop, isScrollKey, ScrollIntentGate, viewportCenter } from './scroll-sync.js';

interface Props {
  snapshot: DocumentSnapshot;
  activeBlock?: string | undefined;
  scrollTarget?: string | undefined;
  scrollProgress?: number | undefined;
  scrollAlignment: 'center' | 'reveal';
  fontFamily: 'serif' | 'sans' | 'mono';
  fontSize: number;
  justified: boolean;
  onApply(block: DocumentBlock, replacement: string): void;
  onNavigate(blockId: string, sourceOffset?: number): void;
  onScroll(blockId: string, progress: number): void;
}

export function VisualEditor({ snapshot, activeBlock, scrollTarget, scrollProgress, scrollAlignment, fontFamily, fontSize, justified, onApply, onNavigate, onScroll }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const scrollIntent = useRef(new ScrollIntentGate());
  const latestOnScroll = useRef(onScroll);
  latestOnScroll.current = onScroll;
  useEffect(() => {
    const target = scrollTarget ? host.current?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(scrollTarget)}"]`) : undefined;
    if (!target) return;
    const container = host.current?.parentElement;
    const next = target.nextElementSibling instanceof HTMLElement ? target.nextElementSibling : undefined;
    scrollIntent.current.beginProgrammatic();
    const moved = container ? (scrollAlignment === 'center' ? centerPoint : revealPoint)(container, target, next, scrollProgress ?? 0) : (target.scrollIntoView({ block: 'center' }), true);
    if (!moved) scrollIntent.current.endProgrammatic();
    else requestAnimationFrame(() => scrollIntent.current.endProgrammatic());
  }, [scrollTarget, scrollProgress, scrollAlignment]);
  useEffect(() => {
    const container = host.current?.parentElement;
    if (!container) return;
    let frame = 0;
    const handle = () => {
      if (!scrollIntent.current.shouldPublish()) return;
      scrollIntent.current.continueScroll();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const blocks = [...(host.current?.querySelectorAll<HTMLElement>('[data-block-id]') ?? [])];
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
  }, [snapshot.revision]);
  return <div className={`visual-editor ${justified ? 'justified' : ''}`} ref={host} aria-label="Visual Markdown editor" style={{ '--viewer-font': fontStack(fontFamily), '--viewer-size': `${fontSize}px` } as CSSProperties}>
    {snapshot.blocks.map((block) => <VisualBlock key={block.id} block={block} active={activeBlock === block.id} onApply={onApply} onNavigate={onNavigate} />)}
  </div>;
}

function VisualBlock({ block, active, onApply, onNavigate }: { block: DocumentBlock; active: boolean; onApply(block: DocumentBlock, replacement: string): void; onNavigate(id: string, sourceOffset?: number): void }) {
  const host = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing || !host.current || !block.editable || block.kind === 'code' || block.kind === 'div' || block.kind === 'table') return;
    let state: EditorState;
    try { state = EditorState.create({ doc: defaultMarkdownParser.parse(block.text) }); }
    catch { return; }
    const editor = new EditorView(host.current, {
      state,
      dispatchTransaction(transaction) { const next = editor.state.apply(transaction); editor.updateState(next); },
      handleDOMEvents: {
        blur(view) {
          const replacement = `${defaultMarkdownSerializer.serialize(view.state.doc).trimEnd()}\n`;
          if (replacement !== block.text) onApply(block, replacement);
          setEditing(false);
          return false;
        },
      },
    });
    editor.focus();
    return () => editor.destroy();
  }, [editing, block, onApply]);

  if (editing) return <section className="visual-block editing" data-block-id={block.id} ref={host} />;
  if (block.kind === 'frontmatter' || block.kind === 'raw') return <section className={`visual-block atomic ${active ? 'active' : ''}`} data-block-id={block.id} onClick={() => onNavigate(block.id, block.from)}><span>Source-backed {block.kind}</span><pre>{block.text}</pre></section>;
  if (block.kind === 'code') return <section className={`visual-block code-block ${active ? 'active' : ''}`} data-block-id={block.id} onClick={(event) => onNavigate(block.id, visualSourceOffset(event, block))}><pre><code>{stripFence(block.text)}</code></pre><span className="inert-badge">Not executed</span></section>;
  return <section
    className={`visual-block ${active ? 'active' : ''}`}
    data-block-id={block.id}
    onClick={(event) => onNavigate(block.id, visualSourceOffset(event, block))}
    onDoubleClick={() => setEditing(true)}
    title="Double-click to edit this block"
    dangerouslySetInnerHTML={{ __html: lightweight(block) }}
  />;
}

function lightweight(block: DocumentBlock): string {
  const escaped = escapeHtml(maskMarkdownHtmlComments(block.text).trim());
  if (block.kind === 'heading') return `<h${block.level ?? 2}>${escaped.replace(/^#{1,6}\s+/, '')}</h${block.level ?? 2}>`;
  if (block.kind === 'quote') return `<blockquote>${escaped.replace(/^&gt;\s?/gm, '')}</blockquote>`;
  if (block.kind === 'list') return `<div class="visual-list">${escaped.replace(/^(?:[-*+] |\d+[.)] )/gm, '• ')}</div>`;
  if (block.kind === 'table') return `<pre class="visual-table">${escaped}</pre>`;
  if (block.kind === 'div') return `<aside class="visual-callout">${escaped.replace(/^:::[^\n]*\n?|\n?:::\s*$/g, '')}</aside>`;
  return `<p>${escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>')}</p>`;
}
function stripFence(value: string): string { return value.replace(/^(```+|~~~+)[^\n]*\n?/, '').replace(/\n?(```+|~~~+)\s*$/, ''); }
function escapeHtml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }

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

function visualSourceOffset(event: ReactMouseEvent<HTMLElement>, block: DocumentBlock): number {
  const caret = document.caretPositionFromPoint?.(event.clientX, event.clientY);
  const legacy = !caret ? (document as Document & { caretRangeFromPoint?(x: number, y: number): Range | null }).caretRangeFromPoint?.(event.clientX, event.clientY) : undefined;
  const node = caret?.offsetNode ?? legacy?.startContainer;
  const offset = caret?.offset ?? legacy?.startOffset;
  if (!node || offset === undefined || !event.currentTarget.contains(node)) return block.from;
  const range = document.createRange();
  range.selectNodeContents(event.currentTarget);
  try { range.setEnd(node, offset); }
  catch { return block.from; }
  const rendered = event.currentTarget.textContent ?? '';
  const ratio = range.toString().length / Math.max(1, rendered.length);
  return Math.min(block.to, block.from + Math.round((block.to - block.from) * ratio));
}

function fontStack(font: Props['fontFamily']): string {
  if (font === 'mono') return '"IBM Plex Mono", "SFMono-Regular", Consolas, monospace';
  if (font === 'sans') return '"Manrope", system-ui, sans-serif';
  return '"Source Serif 4", Georgia, serif';
}
