const INTENT_GRACE_MS = 220;

export interface VerticalViewport {
  readonly top: number;
  readonly height: number;
}

/** The semantic sampling line shared by both panes. */
export function viewportCenter(viewport: VerticalViewport): number {
  return viewport.top + viewport.height / 2;
}

/**
 * Returns the scroll position that places a point at the viewport midpoint.
 * Browser-like clamping keeps the beginning and end of the document reachable.
 */
export function centeredScrollTop(currentScrollTop: number, pointInViewport: number, viewportHeight: number, scrollHeight: number): number {
  const contentPoint = currentScrollTop + pointInViewport;
  const maximum = Math.max(0, scrollHeight - viewportHeight);
  return Math.max(0, Math.min(maximum, contentPoint - viewportHeight / 2));
}

/**
 * Keeps programmatic pane alignment from becoming a new scroll source.
 * Only an interaction that can genuinely scroll a pane may claim ownership.
 */
export class ScrollIntentGate {
  private pointerActive = false;
  private intentUntil = 0;
  private programmatic = false;

  beginPointer(now = performance.now()): void {
    this.pointerActive = true;
    this.markIntent(now);
  }

  endPointer(now = performance.now()): void {
    if (!this.pointerActive) return;
    this.pointerActive = false;
    this.markIntent(now);
  }

  markIntent(now = performance.now()): void {
    this.programmatic = false;
    this.intentUntil = Math.max(this.intentUntil, now + INTENT_GRACE_MS);
  }

  beginProgrammatic(): void {
    this.programmatic = true;
    this.pointerActive = false;
    this.intentUntil = 0;
  }

  endProgrammatic(): void {
    this.programmatic = false;
  }

  shouldPublish(now = performance.now()): boolean {
    return !this.programmatic && (this.pointerActive || now <= this.intentUntil);
  }

  continueScroll(now = performance.now()): void {
    if (this.shouldPublish(now)) this.intentUntil = now + INTENT_GRACE_MS;
  }
}

export function isScrollKey(event: KeyboardEvent): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey) return false;
  return ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key);
}
