import { centeredScrollTop } from './scroll-sync.js';

export type ViewerFont = 'serif' | 'sans' | 'mono';

export function fontStack(font: ViewerFont): string {
  if (font === 'mono') return '"IBM Plex Mono", "SFMono-Regular", Consolas, monospace';
  if (font === 'sans') return '"Manrope", system-ui, sans-serif';
  return '"Source Serif 4", Georgia, serif';
}

/** Realm-independent element check: nodes inside the detached viewer belong to another window's HTMLElement class. */
export function isHtmlElement(value: unknown): value is HTMLElement {
  return typeof value === 'object' && value !== null && 'nodeType' in value && (value as Node).nodeType === 1 && 'hasAttribute' in value;
}

/** Scrolls so the given progress point inside target sits at the container midpoint; false when no movement was needed. */
export function centerPoint(container: HTMLElement, target: HTMLElement, next: HTMLElement | undefined, progress: number): boolean {
  const viewport = container.getBoundingClientRect();
  return scrollToPoint(container, viewport, targetPoint(target, next, progress));
}

/** Like centerPoint, but leaves the container alone when the point is already comfortably visible. */
export function revealPoint(container: HTMLElement, target: HTMLElement, next: HTMLElement | undefined, progress: number): boolean {
  const viewport = container.getBoundingClientRect();
  const point = targetPoint(target, next, progress);
  const margin = Math.min(48, viewport.height * .12);
  if (point >= viewport.top + margin && point <= viewport.bottom - margin) return false;
  return scrollToPoint(container, viewport, point);
}

function targetPoint(target: HTMLElement, next: HTMLElement | undefined, progress: number): number {
  const rect = target.getBoundingClientRect();
  const span = Math.max(0, (next?.getBoundingClientRect().top ?? rect.bottom) - rect.top);
  return rect.top + span * Math.max(0, Math.min(1, progress));
}

function scrollToPoint(container: HTMLElement, viewport: DOMRect, point: number): boolean {
  const nextScrollTop = centeredScrollTop(container.scrollTop, point - viewport.top, viewport.height, container.scrollHeight);
  if (Math.abs(nextScrollTop - container.scrollTop) <= 1) return false;
  container.scrollTop = nextScrollTop;
  return true;
}
