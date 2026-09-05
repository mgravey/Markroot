import { describe, expect, it } from 'vitest';
import { detachedViewerTitle } from './detached-viewer.js';

describe('detached viewer', () => {
  it('keeps the open workspace path visible in the second-window title', () => {
    expect(detachedViewerTitle('chapters/results.qmd')).toBe('chapters/results.qmd — Markroot Viewer');
    expect(detachedViewerTitle()).toBe('Markroot Viewer');
  });
});
