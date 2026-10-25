import { useCallback, useRef } from 'react';

/** A callback with a stable identity that always runs the latest handler (lets memoized panes skip re-renders). */
export function useEvent<A extends unknown[], R>(handler: (...args: A) => R): (...args: A) => R {
  const latest = useRef(handler);
  latest.current = handler;
  return useCallback((...args: A) => latest.current(...args), []);
}
