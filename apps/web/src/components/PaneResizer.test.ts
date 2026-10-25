import { describe, expect, it } from 'vitest';
import { clamp, keyboardValue, separatorAria } from './PaneResizer.js';

describe('pane resizing', () => {
  it('keeps persisted dimensions inside usable bounds', () => {
    expect(clamp(120, 180, 420)).toBe(180);
    expect(clamp(300, 180, 420)).toBe(300);
    expect(clamp(500, 180, 420)).toBe(420);
  });

  it('announces ratios as percentages and widths as pixels', () => {
    expect(separatorAria(0.5, 0.25, 0.75)).toEqual({ min: 25, max: 75, now: 50, text: '50%' });
    expect(separatorAria(0.333, 0.25, 0.75).now).toBe(33);
    expect(separatorAria(240.4, 180, 420)).toEqual({ min: 180, max: 420, now: 240, text: '240 pixels' });
  });

  it('moves with arrow keys and jumps with Home and End', () => {
    expect(keyboardValue('ArrowRight', 0.5, 0.25, 0.75, 0.02)).toBeCloseTo(0.52);
    expect(keyboardValue('ArrowLeft', 190, 180, 420, 12)).toBe(180);
    expect(keyboardValue('ArrowUp', 400, 180, 420, 12)).toBe(412);
    expect(keyboardValue('Home', 300, 180, 420, 12)).toBe(180);
    expect(keyboardValue('End', 300, 180, 420, 12)).toBe(420);
    expect(keyboardValue('Enter', 300, 180, 420, 12)).toBeUndefined();
  });
});
