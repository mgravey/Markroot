import { describe, expect, it } from 'vitest';
import { centerPoint, fontStack, isHtmlElement, revealPoint } from './dom-utils.js';

const rect = (top: number, height: number) => ({ top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
const element = (top: number, height: number) => ({ getBoundingClientRect: () => rect(top, height) }) as HTMLElement;
const container = (scrollTop: number) => ({ scrollTop, scrollHeight: 4_000, getBoundingClientRect: () => rect(0, 600) }) as HTMLElement;

describe('viewer DOM helpers', () => {
  it('maps viewer fonts to stacks', () => {
    expect(fontStack('mono')).toContain('IBM Plex Mono');
    expect(fontStack('sans')).toContain('Manrope');
    expect(fontStack('serif')).toContain('Source Serif 4');
  });

  it('recognizes elements across window realms without instanceof', () => {
    expect(isHtmlElement({ nodeType: 1, hasAttribute: () => false })).toBe(true);
    expect(isHtmlElement({ nodeType: 3 })).toBe(false);
    expect(isHtmlElement(null)).toBe(false);
  });

  it('centers the progress point and reports movement', () => {
    const scroller = container(100);
    expect(centerPoint(scroller, element(800, 200), undefined, 0.5)).toBe(true);
    expect(scroller.scrollTop).toBe(100 + 900 - 300);
    expect(centerPoint(container(0), element(250, 100), undefined, 0.5)).toBe(false);
  });

  it('reveals only points outside the comfortable band', () => {
    const scroller = container(100);
    expect(revealPoint(scroller, element(200, 100), undefined, 0)).toBe(false);
    expect(scroller.scrollTop).toBe(100);
    expect(revealPoint(scroller, element(1_000, 100), element(1_200, 10), 1)).toBe(true);
    expect(scroller.scrollTop).toBe(100 + 1_200 - 300);
  });
});
