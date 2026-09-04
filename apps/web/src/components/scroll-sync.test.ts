import { describe, expect, it } from 'vitest';
import { centeredScrollTop, ScrollIntentGate, viewportCenter } from './scroll-sync.js';

describe('center-line alignment', () => {
  it('uses the true vertical midpoint as the shared reference line', () => {
    expect(viewportCenter({ top: 80, height: 640 })).toBe(400);
  });

  it('centers a mapped point without changing the semantic content point', () => {
    expect(centeredScrollTop(400, 100, 600, 2_000)).toBe(200);
    expect(centeredScrollTop(400, 300, 600, 2_000)).toBe(400);
  });

  it('clamps alignment naturally at the document boundaries', () => {
    expect(centeredScrollTop(0, 100, 600, 2_000)).toBe(0);
    expect(centeredScrollTop(1_300, 500, 600, 2_000)).toBe(1_400);
  });
});

describe('ScrollIntentGate', () => {
  it('does not publish programmatic alignment', () => {
    const gate = new ScrollIntentGate();
    gate.beginProgrammatic();
    expect(gate.shouldPublish(10)).toBe(false);
    gate.endProgrammatic();
    expect(gate.shouldPublish(10)).toBe(false);
  });

  it('publishes real scroll intent without handing ownership back in a loop', () => {
    const gate = new ScrollIntentGate();
    gate.markIntent(100);
    expect(gate.shouldPublish(200)).toBe(true);
    expect(gate.shouldPublish(321)).toBe(false);
    gate.beginProgrammatic();
    gate.markIntent(400);
    expect(gate.shouldPublish(401)).toBe(true);
  });

  it('keeps scrollbar dragging active until pointer release', () => {
    const gate = new ScrollIntentGate();
    gate.beginPointer(0);
    expect(gate.shouldPublish(5_000)).toBe(true);
    gate.endPointer(5_000);
    expect(gate.shouldPublish(5_100)).toBe(true);
    expect(gate.shouldPublish(5_221)).toBe(false);
  });

  it('does not arm unrelated panes on a global pointer release', () => {
    const gate = new ScrollIntentGate();
    gate.endPointer(100);
    expect(gate.shouldPublish(101)).toBe(false);
  });
});
