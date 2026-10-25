// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RecentProject } from '@markroot/settings';
import { ProjectSwitcher, RecentProjects } from './ProjectSwitcher.js';

const projects: readonly RecentProject[] = ['paper', 'notes'].map((name) => ({ id: name, name, lastOpenedAt: 1, handle: { name } as FileSystemDirectoryHandle }));
let cleanup = () => {};
afterEach(() => cleanup());
async function mount() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const props = { projects, currentId: 'notes', rootName: 'notes', onOpen: vi.fn(), onSelect: vi.fn(), onRemove: vi.fn() };
  cleanup = () => { act(() => root.unmount()); host.remove(); };
  await act(async () => { root.render(createElement(ProjectSwitcher, props)); });
  const trigger = host.querySelector<HTMLButtonElement>('.workspace-button')!;
  const key = (target: Element | Window, value: string, options: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options });
    act(() => { target.dispatchEvent(event); });
    return event;
  };
  return { host, root, trigger, props, key };
}

describe('project selector keyboard and focus', () => {
  it('focuses the current project, supports arrows and Escape, and restores trigger focus', async () => {
    const { host, trigger, key } = await mount();
    act(() => trigger.click());
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement?.getAttribute('aria-checked')).toBe('true');
    key(document.activeElement!, 'End');
    expect(document.activeElement?.textContent).toBe('Open folder…');
    key(document.activeElement!, 'Home');
    expect(document.activeElement?.textContent).toBe('paper');
    key(document.activeElement!, 'ArrowDown');
    expect(document.activeElement?.getAttribute('title')).toBe('Remove from list');
    key(document.activeElement!, 'Escape');
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens with Ctrl/Cmd+Shift+O and skips shortcuts already handled by the editor', async () => {
    const { host, trigger, key } = await mount();
    const prevented = new KeyboardEvent('keydown', { key: 'O', ctrlKey: true, shiftKey: true, cancelable: true });
    prevented.preventDefault();
    act(() => { window.dispatchEvent(prevented); });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(key(window, 'O', { metaKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    expect(host.querySelector('[role="menu"]')).not.toBeNull();
    key(document.activeElement!, 'Tab');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('dispatches selection synchronously and keeps a usable focus target after removing an entry', async () => {
    const { host, trigger, props } = await mount();
    act(() => trigger.click());
    const remove = host.querySelector<HTMLButtonElement>('[aria-label="Remove paper from list"]')!;
    act(() => remove.click());
    expect(props.onRemove).toHaveBeenCalledWith('paper');
    expect(document.activeElement?.textContent).toBe('Open folder…');
    const select = host.querySelector<HTMLButtonElement>('[role="menuitemradio"]')!;
    act(() => { select.click(); expect(props.onSelect).toHaveBeenCalledWith(projects[0]); });
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('provides one-click recent projects on the welcome screen', async () => {
    const { host, root, props } = await mount();
    await act(async () => { root.render(createElement(RecentProjects, props)); });
    const select = host.querySelector<HTMLButtonElement>('.project-select')!;
    act(() => { select.click(); expect(props.onSelect).toHaveBeenCalledWith(projects[0]); });
    act(() => host.querySelector<HTMLButtonElement>('.project-remove')!.click());
    expect(props.onRemove).toHaveBeenCalledWith('paper');
  });
});
