// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from 'prosemirror-view';
import { workspacePath } from '@markroot/core';
import { DocumentSession } from '@markroot/document';
import { VisualEditor } from './VisualEditor.js';

let cleanup = () => {};
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function mount() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const snapshot = new DocumentSession(workspacePath('a.md'), 'Original\n').snapshot();
  const onApply = vi.fn();
  let view!: EditorView;
  const focus = EditorView.prototype.focus;
  vi.spyOn(EditorView.prototype, 'focus').mockImplementation(function (this: EditorView) { view = this; focus.call(this); });
  cleanup = () => { act(() => root.unmount()); host.remove(); };
  await act(async () => { root.render(createElement(VisualEditor, {
    snapshot, scrollAlignment: 'center', fontFamily: 'sans', fontSize: 16, justified: false,
    onApply, onNavigate: vi.fn(), onScroll: vi.fn(),
  })); });
  act(() => { host.querySelector('.visual-block')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
  // jsdom has no layout; history and base commands request a selection scroll.
  view.setProps({ handleScrollToSelection: () => true });
  const key = (value: string, options: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key: value, keyCode: value.length === 1 ? value.toUpperCase().charCodeAt(0) : 0, bubbles: true, cancelable: true, ...options });
    act(() => { view.dom.dispatchEvent(event); });
    return event;
  };
  const blur = () => { act(() => { view.dom.dispatchEvent(new FocusEvent('blur')); }); };
  return { host, view, snapshot, onApply, key, blur };
}

describe('visual block editing', () => {
  it('undoes local edits and leaves source untouched on blur after returning to the initial document', async () => {
    const { view, onApply, key, blur } = await mount();
    const initial = view.state.doc;
    view.dispatch(view.state.tr.insertText('Edited ', 1));
    expect(view.state.doc.textContent).toBe('Edited Original');
    expect(onApply).not.toHaveBeenCalled();
    expect(key('z', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(view.state.doc.eq(initial)).toBe(true);
    blur();
    expect(onApply).not.toHaveBeenCalled();
  });

  it.each([{ key: 'Z', shiftKey: true }, { key: 'y' }])('redoes with Ctrl+$key and commits on blur', async ({ key: value, ...options }) => {
    const { view, snapshot, onApply, key, blur } = await mount();
    view.dispatch(view.state.tr.insertText('Edited ', 1));
    key('z', { ctrlKey: true });
    expect(key(value, { ctrlKey: true, ...options }).defaultPrevented).toBe(true);
    expect(view.state.doc.textContent).toBe('Edited Original');
    expect(onApply).not.toHaveBeenCalled();
    blur();
    expect(onApply).toHaveBeenCalledExactlyOnceWith(snapshot.blocks[0], 'Edited Original\n');
  });

  it('prevents native undo and redo at empty history boundaries', async () => {
    const { view, onApply, key, blur } = await mount();
    const initial = view.state.doc;
    for (const options of [{ key: 'z' }, { key: 'Z', shiftKey: true }, { key: 'y' }]) {
      expect(key(options.key, { ctrlKey: true, ...options }).defaultPrevented).toBe(true);
      expect(view.state.doc.eq(initial)).toBe(true);
    }
    view.dispatch(view.state.tr.insertText('Edited ', 1));
    key('z', { ctrlKey: true });
    expect(key('z', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(view.state.doc.eq(initial)).toBe(true);
    blur();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('handles Enter and Backspace through the base keymap', async () => {
    const { view, key, blur, onApply } = await mount();
    const initial = view.state.doc;
    expect(key('Enter').defaultPrevented).toBe(true);
    expect(view.state.doc.childCount).toBe(2);
    expect(key('Backspace').defaultPrevented).toBe(true);
    expect(view.state.doc.eq(initial)).toBe(true);
    blur();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('still cancels edits with Escape before blur can commit them', async () => {
    const { host, view, onApply } = await mount();
    view.dispatch(view.state.tr.insertText('Edited ', 1));
    act(() => {
      view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      view.dom.dispatchEvent(new FocusEvent('blur'));
    });
    expect(host.querySelector('.ProseMirror')).toBeNull();
    expect(host.textContent).toBe('Original');
    expect(onApply).not.toHaveBeenCalled();
  });
});
