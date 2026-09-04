import { describe, expect, it } from 'vitest';
import type { DocumentOutlineItem } from '@markroot/rendering';
import { filterOutlineItems } from './DocumentOutline.js';

const items: readonly DocumentOutlineItem[] = [
  { id: 'one', blockId: 'b1', from: 0, kind: 'section', label: 'Part', level: 1, number: '1' },
  { id: 'two', blockId: 'b2', from: 10, kind: 'section', label: 'Section', level: 2, number: '1.1' },
  { id: 'three', blockId: 'b3', from: 20, kind: 'section', label: 'Detail', level: 3, number: '1.1.1' },
  { id: 'figure', blockId: 'b4', from: 30, kind: 'figure', label: 'Map', number: '1' },
  { id: 'table', blockId: 'b5', from: 40, kind: 'table', label: 'Values', number: '1' },
];

describe('document outline options', () => {
  it('defaults cleanly to two heading levels and hides figures', () => {
    expect(filterOutlineItems(items, 2, false).map((item) => item.id)).toEqual(['one', 'two', 'table']);
  });

  it('can expose deeper headings and figures independently', () => {
    expect(filterOutlineItems(items, 6, true).map((item) => item.id)).toEqual(['one', 'two', 'three', 'figure', 'table']);
  });
});
