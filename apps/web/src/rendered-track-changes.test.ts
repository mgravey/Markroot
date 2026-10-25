// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { applyRenderedTrackChanges, displayDeletedText } from './rendered-track-changes.js';

function article(html: string): HTMLElement {
  const root = document.createElement('article');
  root.innerHTML = html;
  return root;
}

function compare(base: string, current: string): HTMLElement {
  const root = article(current);
  applyRenderedTrackChanges(root, article(base));
  return root;
}

describe('rendered tracked changes', () => {
  it('marks inserted and deleted words inline', () => {
    const root = compare('<p>The quick fox jumps.</p>', '<p>The slow brown fox jumps.</p>');
    expect([...root.querySelectorAll('ins.render-track-insert')].map((node) => node.textContent).join('')).toContain('slow');
    expect([...root.querySelectorAll('ins.render-track-insert')].map((node) => node.textContent).join('')).toContain('brown');
    expect(root.querySelector('del.render-track-delete')?.textContent).toContain('quick');
    expect(root.querySelector('del')?.title).toBe('Deleted text');
  });

  it('leaves identical renders untouched', () => {
    const root = compare('<p>Same <em>text</em>.</p>', '<p>Same <em>text</em>.</p>');
    expect(root.innerHTML).toBe('<p>Same <em>text</em>.</p>');
  });

  it('preserves surrounding markup and the visible current text', () => {
    const root = compare('<h2>Results</h2><p>Old value</p>', '<h2>Results</h2><p>New <strong>value</strong></p>');
    expect(root.querySelector('h2')?.innerHTML).toBe('Results');
    expect(root.querySelector('strong')?.textContent).toBe('value');
    const visible = root.cloneNode(true) as HTMLElement;
    visible.querySelectorAll('del').forEach((node) => node.remove());
    expect(visible.textContent).toBe('ResultsNew value');
  });

  it('never decorates inside atomic rendered content', () => {
    const root = compare('<pre><code>a = 1</code></pre><p>x</p>', '<pre><code>a = 2</code></pre><p>x</p>');
    expect(root.querySelector('pre')?.innerHTML).toBe('<code>a = 2</code>');
  });

  it('formats deleted text for inline display', () => {
    expect(displayDeletedText('one\ntwo￼')).toBe('one ↵ two');
  });
});
