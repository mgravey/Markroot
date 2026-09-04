import { describe, expect, it } from 'vitest';
import { clamp } from './PaneResizer.js';

describe('pane resizing', () => {
  it('keeps persisted dimensions inside usable bounds', () => {
    expect(clamp(120, 180, 420)).toBe(180);
    expect(clamp(300, 180, 420)).toBe(300);
    expect(clamp(500, 180, 420)).toBe(420);
  });
});
