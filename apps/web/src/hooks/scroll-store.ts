import { useSyncExternalStore } from 'react';

export interface ScrollState {
  readonly target: string | undefined;
  readonly progress: number;
  readonly origin: 'source' | 'right' | 'command';
  readonly alignment: 'center' | 'reveal';
}

/**
 * Pane scroll-sync position kept outside React state: scroll events fire every frame, and only the
 * panes that follow the position should re-render, not the whole app.
 */
export class ScrollStore {
  private state: ScrollState = { target: undefined, progress: 0, origin: 'command', alignment: 'reveal' };
  private readonly listeners = new Set<() => void>();

  readonly get = (): ScrollState => this.state;

  set(patch: Partial<ScrollState>): void {
    const next = { ...this.state, ...patch };
    if (next.target === this.state.target && next.progress === this.state.progress && next.origin === this.state.origin && next.alignment === this.state.alignment) return;
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
}

export function useScrollState(store: ScrollStore): ScrollState { return useSyncExternalStore(store.subscribe, store.get); }
