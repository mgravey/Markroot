import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

/** Minimal DOM harness: no scheduler sleeps or testing-library dependency. */
export function mountHook<P, T>(hook: (props: P) => T, initial: P) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let current!: T;
  function Harness({ props }: { props: P }) { current = hook(props); return null; }
  const render = (props: P) => { act(() => root.render(createElement(Harness, { props }))); };
  render(initial);
  return { get current() { return current; }, render, unmount: () => { act(() => root.unmount()); host.remove(); } };
}

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
