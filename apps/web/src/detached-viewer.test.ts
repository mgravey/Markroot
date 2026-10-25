import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { detachedViewerTitle, prepareDetachedViewerDocument } from './detached-viewer.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function windows() {
  const source = new JSDOM('<!doctype html><html><head><style id="app">body{color:red}</style></head><body></body></html>', { url: 'https://markroot.example/app/' }).window;
  const target = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'about:blank' }).window;
  const close = vi.spyOn(target, 'close').mockImplementation(() => undefined);
  const root = prepareDetachedViewerDocument(source.document, target.document, 'notes.md', true);
  return { source, target, close, root };
}

describe('detached viewer', () => {
  it('keeps the open workspace path visible in the second-window title', () => {
    expect(detachedViewerTitle('chapters/results.qmd')).toBe('chapters/results.qmd — Markroot Viewer');
    expect(detachedViewerTitle()).toBe('Markroot Viewer');
  });

  it('copies opener styles and prepares a themed root', () => {
    const { target, root } = windows();
    expect(root.id).toBe('markroot-detached-root');
    expect(target.document.documentElement.dataset.theme).toBe('dark');
    expect(target.document.head.textContent).toContain('body{color:red}');
    expect(target.document.querySelector('base')?.href).toBe('https://markroot.example/app/');
  });

  it('mirrors styles the opener adds, changes or removes after opening', async () => {
    const { source, target } = windows();
    const late = source.document.createElement('style');
    late.textContent = '.late{color:blue}';
    source.document.head.append(late);
    await settle();
    expect(target.document.head.textContent).toContain('.late{color:blue}');
    late.textContent = '.late{color:green}';
    source.document.getElementById('app')!.remove();
    await settle();
    expect(target.document.head.textContent).toContain('.late{color:green}');
    expect(target.document.head.textContent).not.toContain('.late{color:blue}');
    expect(target.document.head.textContent).not.toContain('body{color:red}');
    expect(target.document.head.lastElementChild?.textContent).toContain('markroot-detached-root');
  });

  it('closes with the opener and releases its bindings once the popup is gone', async () => {
    const { source, target, close } = windows();
    source.dispatchEvent(new source.Event('pagehide'));
    expect(close).toHaveBeenCalledTimes(1);
    target.dispatchEvent(new target.Event('pagehide'));
    source.dispatchEvent(new source.Event('pagehide'));
    expect(close).toHaveBeenCalledTimes(1);
    const late = source.document.createElement('style');
    late.textContent = '.after-close{}';
    source.document.head.append(late);
    await settle();
    expect(target.document.head.textContent).not.toContain('.after-close');
  });
});
