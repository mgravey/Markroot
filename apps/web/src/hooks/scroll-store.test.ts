import { describe, expect, it, vi } from 'vitest';
import { ScrollStore } from './scroll-store.js';

describe('ScrollStore', () => {
  it('merges patches and notifies only on change', () => {
    const store = new ScrollStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.set({ target: 'b1', progress: 0.5 });
    store.set({ target: 'b1', progress: 0.5 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get()).toEqual({ target: 'b1', progress: 0.5, origin: 'command', alignment: 'reveal' });
    const before = store.get();
    store.set({ origin: 'source' });
    expect(store.get()).not.toBe(before);
    unsubscribe();
    store.set({ origin: 'right' });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
